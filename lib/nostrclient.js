const {RelayPool,decryptDm, encryptDm} = require('nostr')
const {readKeyFile,createRandomKeyFile} = require('./keys.js');
const {fetchOptionsFromJsonRPCBody, isJsonRPCRequest, isJsonRPCResponse} = require('./toREST.js');
const sqlite3 = require("better-sqlite3");
const {getBlankEvent, validateEvent, verifySignature, getEventHash, signEvent} = require("./nostrEvent.js");
const secp256k1 = require("@noble/secp256k1");

module.exports = class NostrClient {

  constructor( config ) {
    this.dbFile = config.nostrClient.dbFile || './client_state.sqlite3';
    this.privateKeyFile = config.nostrClient.privateKeyFile || './client_privateKey.txt';
    this.relays = config.nostrClient.relays || [
      "wss://relay.damus.io",
      "wss://nostr-pub.wellorder.net",
      "wss://relay.nostr.info"
    ];
    this.updateInterval = config.nostrClient.updateInterval || 25;
    this.maxTries = config.nostrClient.maxTries || 30;
    this.retryAfterSeconds = config.nostrClient.retryAfterSeconds || 30;
    this.onlySubscribeToEventsFrom; // listen to everything to me
    this.setupDatabase();
    this.onNostrEvent = this.onNostrEvent.bind(this);
    this.update = this.update.bind(this);
  }

  setupDatabase() {
    this.db = sqlite3(this.dbFile, {fileMustExist: true});
    this.db.pragma('journal_mode = WAL');

    this.preparedStatements = {
      // denbug
      markAllEventsAsUnprocessed: this.db.prepare('UPDATE events SET processed_at=0, tries=0, status=1'),
      // transactions
      begin: this.db.prepare('BEGIN'),
      commit: this.db.prepare('COMMIT'),
      rollback: this.db.prepare('ROLLBACK'),
      // events
      getLatestEventAt: this.db.prepare('SELECT created_at FROM latest_event_times WHERE relay_url=? LIMIT 1' ),
      upsertLatestEventAt: this.db.prepare('INSERT INTO latest_event_times(relay_url,created_at) VALUES($relay_url,$created_at) ON CONFLICT(relay_url) DO UPDATE SET created_at=CAST(max(CAST(created_at AS INTEGER),CAST(excluded.created_at AS INTEGER)) AS TEXT)'),
      insertEventIntoDB: this.db.prepare('INSERT OR IGNORE INTO events (id, event_json, created_at) VALUES ($id, $event_json, $created_at)'),
      getNextUnprocessedEvent: this.db.prepare('SELECT event_json, created_at FROM events WHERE status>0 AND status<=10 AND tries<? AND processed_at<? ORDER BY created_at LIMIT 1'),
      updateEvent: this.db.prepare('UPDATE events SET status=$status, processed_at=$processed_at, tries = tries + 1 WHERE id=$id')
    };
  }


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

    //this.dbg_markAllEventsAsUnprocessed();

    // now we have a valid config, a private key and a public key
    this.myPrivateKey = keyPair.privateKey;
    this.myPublicKey = keyPair.publicKey;

    console.log('My public key is:', this.myPublicKey);

    // connect to all relays
    this.pool = RelayPool(this.relays);

    // get the subscription config

    this.pool.on('open', relay => {
      // subscribe to events in every relay we are connected to
      const subscriptionConfig = this.getSubscriptionConfig(relay.url);
      relay.subscribe("subid", subscriptionConfig);
    });

    this.pool.on('event', this.onNostrEvent );

    // start the main loop
    this.update();

  }

  async update() {
    const nowSeconds =  parseInt(Date.now()/1000);
    const event = this.getNextUnprocessedEvent( this.maxTries, nowSeconds - this.retryAfterSeconds );
    if( event ) {
      const statusCode = await this.processEvent( event );
      this.updateEvent( event.id, statusCode, nowSeconds );
    }
    setTimeout( this.update, this.updateInterval );
  }

  async processEvent( event ) {
    return 1; // retry
  }

  onNostrEvent(relay, sub_id, event ) {
    console.log( "Incoming event from:", event.pubkey, "on", relay.url );
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

    if( message && (isJsonRPCRequest(messageObj) || isJsonRPCResponse(messageObj) ) ) {
      this.storeEvent(event, relay.url);
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
    const config = { kinds:[4], '#p': [this.myPublicKey]};
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

  async sendToNostr(toKey, obj, waitForAnswer = true, timeout = 30 ) {
    const str =  JSON.stringify(obj);
    const event = await this.compileNostrDMEvent( toKey, str );
    this.pool.send( ["EVENT", event] );
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
      const r = this.preparedStatements.insertEventIntoDB.run( { id: event.id, event_json: JSON.stringify(event), created_at: event.created_at} );
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
