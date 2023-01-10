const {RelayPool,decryptDm,Relay} = require('nostr')
const {readKeyFile,createRandomKeyFile} = require('./keys.js');
const {readJsonFile} = require('./config.js');
const {requestOptionsFromJsonRPCBody, isJsonRPCRequest} = require('./toREST.js');
const NostrClient = require('./nostrClient.js');
const sqlite3 = require('better-sqlite3');
const { SocksProxyAgent } = require('socks-proxy-agent');
const axios = require('axios');
const eventStatusCode = {
  // all good, skip
  0: 'ok',
  // who knows what's gonna happen :-O
  1: 'not processed',
  // retryable
  // unrecoverable, skip
  11: 'unable to connect',
  20: 'bad decrypt',
  21: 'invalid json',
  22: 'no json rpc method',
  23: 'no json rpc id',
  24: 'mapping failed'
};

const resultStatusCode = {
  0: 'not processed',
  1: 'waiting for gotit',
  2: 'result received by other side'
};

// TODO: implement relay optimisation and rotation

module.exports = class Nostrest extends NostrClient {

  constructor( config ) {
    super(config);
    // will also act as a rate limite, since only one event is processed every update
    this.useTor = config.useTor || false;
    let baseURL, httpsAgent;
    if( this.useTor ) {
      httpsAgent = new SocksProxyAgent(config.socksProxy || 'socks5h://127.0.0.1:9050');
      baseURL = config.restOnion;
    } else {
      baseURL = config.restUrl || 'http://127.0.0.1:8080';
    }
    this.httpClient = axios.create({baseURL, httpsAgent, httpAgent: httpsAgent});
  }

  async bootstrap() {

    this.relayUrls = await this.loadRelays();

    for( const relayUrl of this.relayUrls ) {
      console.log( 'adding',relayUrl);
      this.insertRelay(relayUrl);
      this.pool.add(new Relay(relayUrl));
    }
    const subscriptionConfig = this.getSubscriptionConfig( this.staticPublicKey );
    this.pool.on('open', relay => {
      relay.subscribe(this.dataSubid, subscriptionConfig);
    });
  }

  async loadRelays() {
    // load relays from db
    const relaysFromDb = this.getRelays();

    let i = relaysFromDb.length
    // check if they support all the nips we need
    // if not delete from db
    while (i--) {
      if (!await this.checkNips( relaysFromDb[i].url )) {
        this.deleteRelay(relaysFromDb[i].url);
        relaysFromDb.splice(i, 1);
      }
    }
    const exclude = relaysFromDb.map( relay => relay.url );
    const relayUrlsFromFile = await this.chooseRelayUrls( Math.max(0, this.minRelays-relaysFromDb.length), true, exclude );
    return exclude.concat( ...relayUrlsFromFile );
  }

  async processHenlo( pubkey, message ) {
    // Answer with ITSME
    await this.sendToNostr( this.staticPublicKey, this.staticPrivateKey, pubkey, this.createJsonRPCResponse(message.id, {
      verb: 'ITSME',
      relays: this.relayUrls
    }));
  }

  async processGotit( pubkey, message ) {
    // the event with the id message.eventId is no longer interesting for me
    if( message.params && message.params.eventId ) {
      console.log( 'Event was processed', message.params.eventId );
      this.updateResult( message.params.eventId, 2 );
    }
  }

  setupDatabase() {
    super.setupDatabase();
    this.db.pragma('foreign_keys = ON');

    // more prepared statements will be added here:
    this.preparedStatements.insertResultIntoDB=this.db.prepare('INSERT OR IGNORE INTO results (id, pubkey, result_json, created_at) VALUES ($id, $pubkey, $result_json, $created_at)');
    this.preparedStatements.getNextUnprocessedResult=this.db.prepare('SELECT id, pubkey, result_json, created_at FROM results WHERE status=0 AND processed_at<? ORDER BY created_at LIMIT 1');
    this.preparedStatements.updateResult=this.db.prepare('UPDATE results SET status=$status, processed_at=strftime(\'%s\',\'now\') WHERE id=$id');

    this.preparedStatements.getRelays=this.db.prepare('SELECT url, created_at, last_event_at, events_received FROM relays');
    this.preparedStatements.insertRelay=this.db.prepare('INSERT OR IGNORE INTO relays (url, created_at) VALUES (?, strftime(\'%s\',\'now\'))');
    this.preparedStatements.updateRelay=this.db.prepare('UPDATE relays SET last_event_at=strftime(\'%s\',\'now\'), events_received=events_received+1 WHERE url=?' );
    this.preparedStatements.deleteRelay=this.db.prepare('DELETE FROM relays WHERE url=?');

    this.preparedStatements.cleanupNow = this.db.prepare('DELETE FROM events WHERE id IN ( SELECT r.id event_id FROM results r LEFT JOIN events e ON r.id = e.id WHERE r.status=2 AND e.status=0 )');
  }

  createTablesIfNotExists() {
    super.createTablesIfNotExists();
    // create table for results
    this.db.exec(`
CREATE TABLE IF NOT EXISTS relays (
    url TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_event_at INTEGER default 0,
    events_received INTEGER default 0
);

CREATE INDEX IF NOT EXISTS events_last_event_at_index ON relays (last_event_at);

CREATE TABLE IF NOT EXISTS results (
    id CHARACTER(64) PRIMARY KEY,
    pubkey CHARACTER(64) NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    processed_at INTEGER default 0,
    status SMALLINT default 0,
    FOREIGN KEY(id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS events_processes_at_index ON results (processed_at);
CREATE INDEX IF NOT EXISTS events_status_index ON results (status);
    `);
  }

  async onNostrEvent(relay, sub_id, event ) {
    super.onNostrEvent( relay, sub_id, event );
    this.updateRelay( relay.url );
  }

  async processEvent( event ) {
    // '{'jsonrpc':'2.0','id':'foo','method':'mint','params':{'payment_hash':'hash','blinded_messages':['one','two']}}'
    let message, jsonRPCBody;
    try {
      message = decryptDm(this.staticPrivateKey, event);
    } catch (err) {
      return 20;
    }
    console.log('Processing event from', event.pubkey, message);

    try {
      jsonRPCBody = JSON.parse(message);
    } catch (err) {
      return 21;
    }

    if( jsonRPCBody.method.toLowerCase() === 'henlo' ) {
      // someone wants to establish common relays.
      await this.processHenlo( event.pubkey, jsonRPCBody );
      return 0;
    }

    if(  jsonRPCBody.method.toLowerCase() === 'gotit' ) {
      // someone wants to establish common relays.
      await this.processGotit( event.pubkey, jsonRPCBody );
      return 0;
    }

    const { options, errorCode } = requestOptionsFromJsonRPCBody(jsonRPCBody);

    if (errorCode !== undefined) {
      return 21 + errorCode;
    }

    let response;
    try {
      response = await this.httpClient.request(options);
    } catch (err) {
      console.error('REST: Connection refused');
    }
    // that is good
    // post that back to nostr
    let result, error;
    if (response) {
      result = {
        endpoint: options.url,
        httpStatus: response.status,
        body: response.data
      };
    } else {
      error = this.jsonRPCResponseError(11, 'connection refused');
    }
    const jsonRPCResponse = this.createJsonRPCResponse(jsonRPCBody.id, result, error);
    // add ['e', '<event_id>'] of previous event? may leak privacy... hmm
    if( result ) {
      this.storeResult( event.id, event.pubkey, jsonRPCResponse );
      return 0;
    }
    return 11;
  }

  cleanup(nowSeconds ) {
    super.cleanup(nowSeconds);
    const r = this.preparedStatements.cleanupNow.run();
    //console.log( "cleanup now:", r.changes );
  }

  storeResult(id, pubkey, result_json) {
    // insert event into database, so we can process them later. Events received multiple times will only
    // be stored once
    let eventWasStored = false;
    this.preparedStatements.begin.run();
    try {
      const r = this.preparedStatements.insertResultIntoDB.run({
        id: id,
        pubkey: pubkey,
        result_json: JSON.stringify(result_json),
        created_at: parseInt(Date.now()/1000)}
      );
      eventWasStored = r.changes>0;
      this.preparedStatements.commit.run();
    } finally {
      if (this.db.inTransaction) {
        this.preparedStatements.rollback.run();
      }
    }
    return eventWasStored;
  }

  async processResult( pubkey, jsonRPCResponse ) {
    console.log('Processing result to', pubkey, jsonRPCResponse);
    await this.sendToNostr( this.staticPublicKey, this.staticPrivateKey, pubkey, jsonRPCResponse );
    return 1; // waiting for got it
  }


  async update( nowSeconds ) {
    await super.update( nowSeconds );
    const resultWrapper = this.getNextUnprocessedResult( this.maxTries, nowSeconds - this.retryAfterSeconds );
    if( resultWrapper ) {
      const statusCode = await this.processResult( resultWrapper.pubkey, resultWrapper.result );
      this.updateResult( resultWrapper.id, statusCode );
    }
  }

  getNextUnprocessedResult( processedAtBefore ) {
    // throws
    const eventWrapper = this.preparedStatements.getNextUnprocessedResult.get( processedAtBefore );
    if( !eventWrapper ) {
      return;
    }

    return {
      id: eventWrapper.id,
      pubkey: eventWrapper.pubkey,
      result: JSON.parse( eventWrapper.result_json )
    };
  }

  updateResult( id, status ) {
    const r = this.preparedStatements.updateResult.run({id,status});
    return r.changes;
  }

  getRelays() {
    return this.preparedStatements.getRelays.all();
  }

  insertRelay( url ) {
    const r = this.preparedStatements.insertRelay.run(url);
    return r.changes;
  }

  updateRelay( url ) {
    const r = this.preparedStatements.updateRelay.run(url);
    return r.changes;
  }

  deleteRelay( url ) {
    const r = this.preparedStatements.deleteRelay.run(url);
    return r.changes;
  }



}
