const {RelayPool,decryptDm, encryptDm, Relay} = require('nostr')
const {readKeyFile,createRandomKeyFile} = require('./keys.js');
const {requestOptionsFromJsonRPCBody, isJsonRPCRequest, isJsonRPCResponse, validMethods} = require('./toREST.js');
const sqlite3 = require('better-sqlite3');
const {getBlankEvent, validateEvent, verifySignature, getEventHash, signEvent} = require('./nostrEvent.js');
const secp256k1 = require('@noble/secp256k1');
const { v4: uuidv4 } = require('uuid');
const {readJsonFile} = require('./config');
const axios = require('axios');

module.exports = class NostrClient {

  static EPHEMERAL_EVENT_KIND = 23338;
  static DM_KIND = 4;

  static BASIC_NIPS = [1,12]
  static EPHEMERAL_EVENTS_NIP = 16;

  constructor( config ) {
    this.dataSubid = uuidv4();
    this.receivedCountThreshold = 1;

    this.lastCleanUpAt = 0;
    this.cleanUpIntervalSeconds = 10;

    this.waitForOk = config.nostrClient.waitForOk===true;
    this.useEphemeralEvents = config.nostrClient.useEphemeralEvents===true;

    this.relayUrlsFile = config.nostrClient.relayUrlsFile;
    this.defaultRelay = config.nostrClient.defaultRelay;
    this.minRelays = config.nostrClient.minRelays || 10;
    this.dbFile = config.nostrClient.dbFile || './client_state.sqlite3';
    this.privateKeyFile = config.nostrClient.privateKeyFile || './client_privateKey.txt';

    this.keyPairs = {};

    this.updateInterval = config.nostrClient.updateInterval || 25;
    this.maxTries = config.nostrClient.maxTries || 30;
    this.retryAfterSeconds = config.nostrClient.retryAfterSeconds || 30;

    this.onlySubscribeToEventsFrom = undefined;
    this.setupDatabase();
    this.onNostrEvent = this.onNostrEvent.bind(this);
    this.onNostrOk = this.onNostrOk.bind(this);
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
      insertEventIntoDB: this.db.prepare('INSERT INTO events (id, kind, event_json, created_at) VALUES ($id, $kind, $event_json, $created_at) ON CONFLICT(id) DO UPDATE SET rcvs=rcvs+1'),
      getNextUnprocessedEvent: this.db.prepare('SELECT event_json, created_at FROM events WHERE status>0 AND status<=10 AND tries<? AND processed_at<? ORDER BY created_at LIMIT 1'),
      updateEvent: this.db.prepare('UPDATE events SET status=$status, processed_at=$processed_at, tries = tries + 1 WHERE id=$id'),
      deleteEvent: this.db.prepare('DELETE FROM events WHERE id=?'),
      cleanupProcessedEvents: this.db.prepare('DELETE FROM events WHERE status=0 AND created_at < strftime(\'%s\',\'now\', \'-30 minute\')'),
      cleanupOldEvents: this.db.prepare('DELETE FROM events WHERE status>10 AND created_at < strftime(\'%s\',\'now\', \'-60 minute\')'),
    };

  }

  createTablesIfNotExists() {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS events (
    id CHARACTER(64) PRIMARY KEY,
    kind INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    processed_at INTEGER default 0,
    tries SMALLINT default 0,
    rcvs SMALLINT default 1,
    status SMALLINT default 1
);

CREATE INDEX IF NOT EXISTS events_processes_at_index ON events (processed_at);
CREATE INDEX IF NOT EXISTS events_status_index ON events (status);
`);
  }

  async chooseRelayUrls(minRelays, checkNips = false, exclude = []) {
    // curl -H 'Accept: application/nostr+json' https://<relay-url>
    // supported_nips must contain 16 (ephemeral events)
    //   or
    // nip9 (delete)
    minRelays = Math.min( this.availableRelayUrls.length, parseInt(minRelays) );
    if( minRelays === 0 ) {
      return [];
    }
    const relayUrls = [this.defaultRelay];
    // create random ordered relay list
    const availableRelayUrls = this.availableRelayUrls.slice()
      .filter( url => !exclude.includes( url ))
      .sort(() => 0.5 - Math.random());
    while( relayUrls.length < minRelays && availableRelayUrls.length > 0) {
      const relayUrl = availableRelayUrls.pop(); // random element. We can't choose that again
      if( relayUrl && (!checkNips || await this.checkNips(relayUrl) ) ) {
        relayUrls.push(relayUrl);
      }
    }
    return relayUrls;
  }

  async checkNips( relayUrl ) {
    const requiredNips = NostrClient.BASIC_NIPS.slice();
    if( this.useEphemeralEvents ) {
      requiredNips.push(NostrClient.EPHEMERAL_EVENTS_NIP);
    }
    console.log( 'Checking', relayUrl,'for required nips', requiredNips );

    if( relayUrl.startsWith('ws://') ) {
      relayUrl = 'http'+relayUrl.substring(2);
    } else if( relayUrl.startsWith('wss://') ) {
      relayUrl = 'https'+relayUrl.substring(3);
    };

    if( relayUrl.startsWith('http://') || relayUrl.startsWith('https://') ) {
      try {
        const response = await axios.get(relayUrl, {
          headers: {accept: 'application/nostr+json'}
        });
        if( response.status === 200 &&
          response.data &&
          response.data.supported_nips &&
          response.data.supported_nips.length ) {
          for( const requiredNip of requiredNips ) {
            if( !response.data.supported_nips.includes(requiredNip) ) {
              console.log('nope.');
              return false;
            }
          }
          console.log('ok.');
          return true;
        }
      } catch(e) {
        console.log('nope.');
        return false;
      }
    }
    console.log('nope.');
    return false;
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
    this.staticPrivateKey = keyPair.privateKey;
    this.staticPublicKey = keyPair.publicKey;

    this.setKeyPair(this.staticPublicKey, this.staticPrivateKey);

    console.log('My public key is:', this.staticPublicKey);

    // connect to all relays
    this.pool = RelayPool([]);
    this.pool.on('event', this.onNostrEvent );

    if( this.waitForOk && !this.useEphemeralEvents ) {
      this.sentEvents = {};
      this.pool.on('ok', this.onNostrOk );
    }

    await this.bootstrap();
    // start the main loop
    this._update();
  }

  async _update() {
    const nowSeconds =  parseInt(Date.now()/1000);
    await this.update(nowSeconds);
    setTimeout( this._update, this.updateInterval );
  }

  getPrivateKey( publicKey ) {
    return this.keyPairs[publicKey];
  }

  setKeyPair( publicKey, privateKey ) {
    this.keyPairs[publicKey] = privateKey;
  }

  deleteKeyPair( publicKey ) {
    delete this.keyPairs[publicKey]
  }

  async update(nowSeconds) {
    // we have enough common relays
    const event = this.getNextUnprocessedEvent( this.maxTries, nowSeconds - this.retryAfterSeconds );
    if( event ) {
      const statusCode = await this.processEvent( event );
      this.updateEvent( event.id, statusCode, nowSeconds );
    }

    if( nowSeconds - this.lastCleanUpAt > this.cleanUpIntervalSeconds ) {
      this.cleanup( nowSeconds );
    }
  }

  cleanup( nowSeconds ) {
    this.lastCleanUpAt = nowSeconds;
    let r = this.preparedStatements.cleanupProcessedEvents.run();
    //console.log( "cleanup processed events:", r.changes );
    r = this.preparedStatements.cleanupOldEvents.run();
    //console.log( "cleanup old events:",r.changes );
  }

  async processEvent( event ) {
    return 1; // retry
  }

  async onNostrOk( relay, eventId, received, info  ) {
    if( received ) {
      if( this.sentEvents[eventId] !== undefined ) {
        this.sentEvents[eventId]++;
      }
    } else {
      console.log( 'Relay:',relay.url,'did not receive event ',eventId,'because: "'+info+'"');
    }
  }

  getRecipient( event ) {
    if( !event ) {
      return;
    }
    if( event.tags && event.tags.length ) {
      for( const tag of event.tags ) {
        if( tag[0] === 'p' ) {
          // has receipient
          return tag[1];
        }
      }
    }
  }

  async onNostrEvent(relay, sub_id, event ) {
    let message;

    if( !event ) {
      return
    }

    if( (!this.useEphemeralEvents && event.kind !== NostrClient.DM_KIND) ||
        (this.useEphemeralEvents && event.kind !== NostrClient.EPHEMERAL_EVENT_KIND ) ) {
      return;
    }

    const privateKey = this.getPrivateKey( this.getRecipient(event) );

    if( !privateKey ) {
      return;
    }

    try {
      message = decryptDm( privateKey, event );
    } catch ( err) {
      return;
    }
    let messageObj;

    try {
      messageObj = JSON.parse( message );
    } catch ( err) {
      return;
    }

    if ( isJsonRPCRequest(messageObj) || isJsonRPCResponse(messageObj) ) {
      this.storeEvent(event, relay.url);
    }
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

  getSubscriptionConfig( toPublicKey, fromPublicKey ) {
    const config = {
      kinds:[this.useEphemeralEvents?NostrClient.EPHEMERAL_EVENT_KIND:NostrClient.DM_KIND],
      '#p': [toPublicKey],
      //since: parseInt( Date.now()/1000 ),
      //limit: 0
    };
    if( fromPublicKey ) {
      config.authors = [fromPublicKey];
    }
    return config;
  }

  async sendToNostr(fromPubkey, fromPrivKey, toPubkey, message ) {
    const eventId = this.useEphemeralEvents?
      await this.sendNostrEphemeralDM( fromPubkey, fromPrivKey, toPubkey, message ):
      await this.sendNostrDM( fromPubkey, fromPrivKey, toPubkey, message );

    console.log( `SND ${eventId} -> ${toPubkey}`);
    if( this.waitForOk && !this.useEphemeralEvents ) {
      if( eventId ) {
        this.sentEvents[eventId] = 0;
      }

      let timedOut = false;
      let rt = setTimeout( () => {
        timedOut = true;
      }, 1000 ); // wait two seconds for ok

      // wait for OKs coming in from the relays
      while( !timedOut ) {
        if( this.sentEvents[eventId] > this.receivedCountThreshold ) {
          clearTimeout( rt );
          delete this.sentEvents[eventId];
          return eventId;
        }
        await ( new Promise( (resolve) => { setTimeout(resolve,5); } ) ); // wait a few millis
      }
    }
    return eventId;
  }

  async sendNostrDM(fromPubkey, fromPrivkey, toPubkey, obj, waitForAnswer = true, timeout = 30 ) {
    const str =  JSON.stringify(obj);
    const event = await this.compileNostrEvent( NostrClient.DM_KIND, fromPubkey, fromPrivkey, toPubkey, str );
    this.pool.send( ['EVENT', event] );
    return event.id;
  }

  async sendNostrEphemeralDM(fromPubkey, fromPrivkey, toPubkey, obj, waitForAnswer = true, timeout = 30 ) {
    const str =  JSON.stringify(obj);
    const event = await this.compileNostrEvent(  NostrClient.EPHEMERAL_EVENT_KIND, fromPubkey, fromPrivkey, toPubkey, str );
    //console.log( 'snd', event);
    this.pool.send( ['EVENT', event] );
    return event.id;
  }

  async compileNostrEvent( kind, fromPubkey, fromPrivkey, toPubkey, message ) {
    const event = {
      created_at: parseInt(Date.now()/1000),
      pubkey: fromPubkey,
      kind: kind,
      tags: [['p',toPubkey]],
      content: encryptDm( fromPrivkey, toPubkey, message ),
    };
    event.id = getEventHash(event);
    event.sig = await signEvent(event, fromPrivkey);
    return event;
  }

  /* db stuff */

  storeEvent(event, relayUrl) {
    const r = this.preparedStatements.insertEventIntoDB.run( { id: event.id, kind: event.kind, event_json: JSON.stringify(event), created_at: event.created_at} );
    // event was stored
    return r.changes>0;
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

  deleteEvent( id ) {
    const r = this.preparedStatements.deleteEvent.run(id);
    return r.changes;
  }

  dbg_markAllEventsAsUnprocessed() {
    this.preparedStatements.markAllEventsAsUnprocessed.run();
  }

}
