const {RelayPool,decryptDm,Relay} = require('nostr')
const {readKeyFile,createRandomKeyFile} = require('./keys.js');
const {readJsonFile} = require('./config.js');
const {requestOptionsFromJsonRPCBody, isJsonRPCRequest} = require('./toREST.js');
const NostrClient = require('./nostrclient');
const sqlite3 = require('better-sqlite3');
const { SocksProxyAgent } = require('socks-proxy-agent')
const axios = require('axios')

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

// TODO: save relay list for next startup

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
    this.relayUrls = this.chooseRelayUrls( this.minRelays );

    for( const relayUrl of this.relayUrls ) {
      console.log( 'adding',relayUrl);
      this.pool.add(new Relay(relayUrl));
    }

    this.pool.on('open', relay => {
      // subscribe to events in every relay we are connected to
      const subscriptionConfig = this.getSubscriptionConfig(relay.url);
      relay.subscribe(this.dataSubid, subscriptionConfig);
    });

    //this.dbg_markAllEventsAsUnprocessed();
  }

  async processHenlo( pubkey, message ) {
    // Answer with ITSME
    await this.sendNostrEphemeralDM( pubkey, this.createJsonRPCResponse(message.id, {
      verb: 'ITSME',
      relays: this.relayUrls
    }));
  }

  async processGotit( pubkey, message ) {
    // the event with the id message.eventId is no longer interesting for me
    if( message.params ) {
      console.log( 'Event was processed', message.params.eventId );
    }
  }

  setupDatabase() {
    super.setupDatabase();
    // more prepared statements will be added here:
    this.preparedStatements.insertResultIntoDB=this.db.prepare('INSERT OR IGNORE INTO results (id, pubkey, result_json, created_at) VALUES ($id, $pubkey, $result_json, $created_at)');
    this.preparedStatements.getNextUnprocessedResult=this.db.prepare('SELECT id, pubkey, result_json, created_at FROM results WHERE status=0 AND processed_at<? ORDER BY created_at LIMIT 1');
    this.preparedStatements.updateResult=this.db.prepare('UPDATE results SET status=$status, processed_at=$processed_at WHERE id=$id');
  }

  createTablesIfNotExists() {
    super.createTablesIfNotExists();
    // create table for results
    this.db.exec(`

CREATE TABLE IF NOT EXISTS results (
    id CHARACTER(64) PRIMARY KEY,
    pubkey CHARACTER(64) NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    processed_at INTEGER default 0,
    status SMALLINT default 0
);

CREATE INDEX IF NOT EXISTS events_processes_at_index ON results (processed_at);
CREATE INDEX IF NOT EXISTS events_status_index ON results (status);
    `);
  }

  async processEvent( event ) {
    // '{'jsonrpc':'2.0','id':'foo','method':'mint','params':{'payment_hash':'hash','blinded_messages':['one','two']}}'
    let message, jsonRPCBody;
    try {
      message = decryptDm(this.myPrivateKey, event);
    } catch (err) {
      return 20;
    }
    console.log('Processing', event.kind, message);

    try {
      jsonRPCBody = JSON.parse(message);
    } catch (err) {
      return 21;
    }

    if( event.kind === NostrClient.EPHEMERAL_DM_KIND && jsonRPCBody.method.toLowerCase() === 'henlo' ) {
      // someone wants to establish common relays.
      await this.processHenlo( event.pubkey, jsonRPCBody );
      return 0;
    }

    if(  event.kind === NostrClient.EPHEMERAL_DM_KIND && jsonRPCBody.method.toLowerCase() === 'gotit' ) {
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
      //await this.sendNostrEphemeralDM( event.pubkey, jsonRPCResponse );
      this.storeResult( event.id, event.pubkey, jsonRPCResponse );
      return 0;
    }
    return 11;
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
    await this.sendNostrEphemeralDM( pubkey, jsonRPCResponse );
    return 1; // waiting for got it
  }


  async update( nowSeconds ) {
    await super.update( nowSeconds );
    const resultWrapper = this.getNextUnprocessedResult( this.maxTries, nowSeconds - this.retryAfterSeconds );
    if( resultWrapper ) {
      const statusCode = await this.processResult( resultWrapper.pubkey, resultWrapper.result );
      this.updateResult( resultWrapper.id, statusCode, nowSeconds );
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

  updateResult( id, status, processed_at ) {
    const r = this.preparedStatements.updateResult.run({id,status,processed_at});
    return r.changes;
  }

}
