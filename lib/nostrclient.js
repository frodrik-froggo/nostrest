const {RelayPool,decryptDm, encryptDm, Relay} = require('nostr')
const {readKeyFile,createRandomKeyFile} = require('./keys.js');
const {requestOptionsFromJsonRPCBody, isJsonRPCRequest, isJsonRPCResponse, validMethods} = require('./toREST.js');
const sqlite3 = require('better-sqlite3');
const {getBlankEvent, validateEvent, verifySignature, getEventHash, signEvent} = require('./nostrEvent.js');
const secp256k1 = require('@noble/secp256k1');
const { v4: uuidv4 } = require('uuid');
const {readJsonFile} = require('./config');

module.exports = class NostrClient {

  static EPHEMERAL_DM_KIND = 20004;

  constructor( config ) {
    this.dataSubid = uuidv4();

    this.relayUrlsFile = config.nostrClient.relayUrlsFile;
    this.defaultRelay = config.nostrClient.defaultRelay;
    this.minRelays = config.nostrClient.minRelays || 10;
    this.dbFile = config.nostrClient.dbFile || './client_state.sqlite3';
    this.privateKeyFile = config.nostrClient.privateKeyFile || './client_privateKey.txt';

    this.updateInterval = config.nostrClient.updateInterval || 25;
    this.maxTries = config.nostrClient.maxTries || 30;
    this.retryAfterSeconds = config.nostrClient.retryAfterSeconds || 30;
    this.onlySubscribeToEventsFrom; // listen to everything to me
    this.setupDatabase();
    this.onNostrEvent = this.onNostrEvent.bind(this);
    this._update = this._update.bind(this);
  }

  setupDatabase() {
    this.db = sqlite3(this.dbFile);
    this.db.pragma('journal_mode = WAL');
    this.createTablesIfNotExists();

    this.preparedStatements = {
      // debug
      markAllEventsAsUnprocessed: this.db.prepare('UPDATE events SET processed_at=0, tries=0, status=1'),
      // transactions
      begin: this.db.prepare('BEGIN'),
      commit: this.db.prepare('COMMIT'),
      rollback: this.db.prepare('ROLLBACK'),
      // events
      getLatestEventAt: this.db.prepare('SELECT created_at FROM latest_event_times WHERE relay_url=? LIMIT 1' ),
      upsertLatestEventAt: this.db.prepare('INSERT INTO latest_event_times(relay_url,created_at) VALUES($relay_url,$created_at) ON CONFLICT(relay_url) DO UPDATE SET created_at=CAST(max(CAST(created_at AS INTEGER),CAST(excluded.created_at AS INTEGER)) AS TEXT)'),
      insertEventIntoDB: this.db.prepare('INSERT INTO events (id, kind, event_json, created_at) VALUES ($id, $kind, $event_json, $created_at) ON CONFLICT(id) DO UPDATE SET rcvs=rcvs+1'),
      getNextUnprocessedEvent: this.db.prepare('SELECT event_json, created_at FROM events WHERE status>0 AND status<=10 AND tries<? AND processed_at<? ORDER BY created_at LIMIT 1'),
      updateEvent: this.db.prepare('UPDATE events SET status=$status, processed_at=$processed_at, tries = tries + 1 WHERE id=$id')
    };

  }

  createTablesIfNotExists() {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS latest_event_times (
    relay_url TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id CHARACTER(64) PRIMARY KEY,
    kind INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    processed_at INTEGER default 0,
    tries SMALLINT default 0,
    rcvs SMALLINT default 0,
    status SMALLINT default 1
);

CREATE INDEX IF NOT EXISTS events_kind_index ON events (kind);
CREATE INDEX IF NOT EXISTS events_processes_at_index ON events (processed_at);
CREATE INDEX IF NOT EXISTS events_created_at_index ON events (created_at);
CREATE INDEX IF NOT EXISTS events_status_index ON events (status);
`);
  }

  chooseRelayUrls(minRelays, checkNips = false) {
    // curl -H 'Accept: application/nostr+json' https://<relay-url>
    // supported_nips must contain 16 (ephemeral events)
    let relayUrls = this.availableRelayUrls.slice();
    // shuffle
    relayUrls = relayUrls.sort(() => 0.5 - Math.random());
    // pick some
    relayUrls = relayUrls.slice(0, minRelays);
    if( this.defaultRelay && !relayUrls.some( e => e === this.defaultRelay ) ) {
      relayUrls[0]=this.defaultRelay;
    }
    return relayUrls;
  }

  async bootstrap() {}

  async start() {

    let keyPair;
    try {
      keyPair = await readKeyFile( this.privateKeyFile );
    } catch( _ ) {
      try {
        keyPair = await createRandomKeyFile( this.privateKeyFile );
      } catch( err ) {
        console.error( err.toString() );
        return;
      }
    }

    if( this.relayUrlsFile ) {
      // TODO: get this from network?
      this.availableRelayUrls = await readJsonFile( this.relayUrlsFile );
    }

    // now we have a valid config, a private key and a public key
    this.myPrivateKey = keyPair.privateKey;
    this.myPublicKey = keyPair.publicKey;

    console.log('My public key is:', this.myPublicKey);

    // connect to all relays
    this.pool = RelayPool([]);
    this.pool.on('event', this.onNostrEvent );

    await this.bootstrap();
    // start the main loop
    this._update();
  }

  async _update() {
    const nowSeconds =  parseInt(Date.now()/1000);
    await this.update(nowSeconds);
    setTimeout( this._update, this.updateInterval );
  }


  async update(nowSeconds) {
    // we have enough common relays
    const event = this.getNextUnprocessedEvent( this.maxTries, nowSeconds - this.retryAfterSeconds );
    if( event ) {
      const statusCode = await this.processEvent( event );
      this.updateEvent( event.id, statusCode, nowSeconds );
    }
  }

  async processEvent( event ) {
    return 1; // retry
  }

  async onNostrEvent(relay, sub_id, event ) {
    let message;
    try {
      message = decryptDm( this.myPrivateKey, event );
    } catch ( err) {
      console.error('bad decrypt');
      return;
    }
    let messageObj;

    try {
      messageObj = JSON.parse( message );
    } catch ( err) {
      console.error('bad json');
      return;
    }
    console.log('rcv', event, messageObj );
    if ( isJsonRPCRequest(messageObj) || isJsonRPCResponse(messageObj) ) {
      this.storeEvent(event, relay.url);
    }
  }

  async handleNonJsonRPCEvent(pubkey, message, relayUrl ) {

  }

  createJsonRPCBody( method, params) {
    return {
      jsonrpc: '2.0',
      id: uuidv4(),
      method,
      params
    }
  }

  createJsonRPCResponse(id, result, error ) {
    const resp = {
      jsonrpc: '2.0',
      id: id
    }

    if( result ) {
      resp.result = result;
    }

    if( error ) {
      resp.error = error;
    }

    return resp;
  }

  jsonRPCResponseError( code, message ) {
    return {
      code,
      message
    };
  }

  getSubscriptionConfig( relayUrl ) {
    // get timestamp of latest received event. This is stored in kv
    const latestEventAt = this.getLatestEventAt(relayUrl);
    const config = { kinds:[NostrClient.EPHEMERAL_DM_KIND], '#p': [this.myPublicKey]};
    if( this.onlySubscribeToEventsFrom ) {
      config.authors = [this.onlySubscribeToEventsFrom];
    }
    if( latestEventAt ) {
      // only get events we didn't process yet and future ones
      // only listen to encrypted direct messages to me
      config.since = latestEventAt;
      return config;
    } else {
      // get all past events, no limit and future ones
      // only listen to encrypted direct messages to me
      return config;
    }
  }

  async sendNostrDM(toKey, obj, waitForAnswer = true, timeout = 30 ) {
    const str =  JSON.stringify(obj);
    const event = await this.compileNostrDMEvent( toKey, str );
    this.pool.send( ['EVENT', event] );
  }

  async sendNostrEphemeralDM(toKey, obj, waitForAnswer = true, timeout = 30 ) {
    const str =  JSON.stringify(obj);
    const event = await this.compileNostrEphemeralDMEvent( toKey, str );
    console.log( 'snd', event);
    this.pool.send( ['EVENT', event] );
  }

  async compileNostrDMEvent( toKey, message ) {
    const event = getBlankEvent();
    event.pubkey = this.myPublicKey;
    event.tags.push(['p',toKey]);
    event.content = encryptDm( this.myPrivateKey, toKey, message );
    event.kind = 4;
    event.created_at = parseInt(Date.now()/1000);
    event.id = getEventHash(event);
    event.sig = await signEvent(event, this.myPrivateKey);
    return event;
  }

  async compileNostrEphemeralDMEvent(toKey, message ) {
    const event = getBlankEvent();
    event.pubkey = this.myPublicKey;
    event.tags.push(['p',toKey]);
    event.content = encryptDm( this.myPrivateKey, toKey, message );
    event.kind = NostrClient.EPHEMERAL_DM_KIND;
    event.created_at = parseInt(Date.now()/1000);
    event.id = getEventHash(event);
    event.sig = await signEvent(event, this.myPrivateKey);
    return event;
  }


  /* db stuff */

  getLatestEventAt(relayUrl) {
    const r = this.preparedStatements.getLatestEventAt.get(relayUrl);
    if( r ) {
      return r.created_at;
    }
    return 0;
  }

  upsertLatestEventAt(relayUrl, created_at) {
    this.preparedStatements.upsertLatestEventAt.run({
      relay_url: relayUrl,
      created_at: created_at
    });
  }

  storeEvent(event, relayUrl) {
    // insert event into database, so we can process them later. Events received multiple times will only
    // be stored once
    let eventWasStored = false;
    this.preparedStatements.begin.run();
    try {
      const r = this.preparedStatements.insertEventIntoDB.run( { id: event.id, kind: event.kind, event_json: JSON.stringify(event), created_at: event.created_at} );
      eventWasStored = r.changes>0;
      this.upsertLatestEventAt(relayUrl, event.created_at);
      this.preparedStatements.commit.run();
    } finally {
      if (this.db.inTransaction) {
        this.preparedStatements.rollback.run();
      }
    }
    return eventWasStored;
  }

  getNextUnprocessedEvent( maxTries, processedAtBefore ) {
    // throws
    const eventWrapper = this.preparedStatements.getNextUnprocessedEvent.get( maxTries, processedAtBefore );
    if( !eventWrapper ) {
      return;
    }
    return JSON.parse( eventWrapper.event_json );
  }

  updateEvent( id, status, processed_at ) {
    const r = this.preparedStatements.updateEvent.run({id,status,processed_at});
    return r.changes;
  }

  dbg_markAllEventsAsUnprocessed() {
    this.preparedStatements.markAllEventsAsUnprocessed.run();
  }

}
