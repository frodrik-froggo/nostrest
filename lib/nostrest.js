const {RelayPool,decryptDm} = require('nostr')
const DB = require('./db.js');
const {readKeyFile,createRandomKeyFile} = require('./keys.js');
const {readConfigFile} = require('./config.js');
const {fetchOptionsFromJsonRPCBody, isJSONRPC} = require('./toREST.js');
const {cashuRestMapper} = require('./cashuRestMapper.js');

const statusCode = {
  // all good, skip
  0: 'ok',
  // who knows what's gonna happen :-O
  1: 'not processed',
  // retryable
  10: 'unable to connect',
  // unrecoverable, skip
  20: 'bad decrypt',
  21: 'invalid json',
  22: 'no json rpc method',
  23: 'no json rpc id',
  24: 'mapping failed'
};

module.exports = class Nostrest {

  constructor( config ) {
    this.dbFile = config.dbFile || './state.sqlite3';
    this.privateKeyFile = config.privateKeyFile || './privateKey.txt';
    this.relays = config.relays || [
      "wss://relay.damus.io",
      "wss://nostr-pub.wellorder.net",
      "wss://relay.nostr.info"
    ];
    this.restUrl = config.restUrl || 'http://127.0.0.1:8080';
    // will also act as a rate limite, since only one event is processed every update
    this.updateInterval = config.updateInterval || 25;
    this.maxTries = config.maxTries || 30;
    this.retryAfterSeconds = config.retryAfterSeconds || 30;
    this.useTor = config.useTor || false;
    this.restOnion = config.restOnion;
    this.update = this.update.bind(this);
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

    this.db = new DB( this.dbFile );

    // now we have a valid config, a private key and a public key
    this.myPrivateKey = keyPair.privateKey;
    this.myPublicKey = keyPair.publicKey;

    console.log('My public key is:', this.myPublicKey);

    // init the key value store
    this.db.dbg_markAllEventsAsUnprocessed();

    // connect to all relays
    this.pool = RelayPool(this.relays);

    // get the subscription config
    const subscriptionConfig = this.getSubscriptionConfig(this.myPublicKey);

    this.pool.on('open', relay => {
      // subscribe to events in every relay we are connected to
      relay.subscribe("subid", subscriptionConfig);
    });

    this.pool.on('event', (relay, sub_id, event) => {
      console.log( "Incoming event:", JSON.stringify(event, null, 2) );
      let message;
      try {
        message = decryptDm( this.myPrivateKey, event );
      } catch ( err) {
        console.error('bad decrypt');
      }
      if( message && isJSONRPC(message) ) {
        this.db.storeEvent(event, relay.url);
      }
    });
    // start the main loop
    this.update();
  }

  jsonRPCResponse( id, result, error ) {
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

  async update() {
    const nowSeconds =  parseInt(Date.now()/1000);
    const event = this.db.getNextUnprocessedEvent( this.maxTries, nowSeconds - this.retryAfterSeconds );
    if( event ) {
      const statusCode = await this.processEvent( event );
      this.db.updateEvent( event.id, statusCode, nowSeconds );
    }
    setTimeout( this.update, this.updateInterval );
  }

  async processEvent( event ) {
    // '{"jsonrpc":"2.0","id":"foo","method":"mint","params":{"payment_hash":"hash","blinded_messages":["one","two"]}}'
    let message, jsonRPCBody;
    try {
      message = decryptDm( this.myPrivateKey, event );
    } catch ( err) {
      return 20;
    }
    console.log( "Processing", event.id, message );

    try {
      jsonRPCBody = JSON.parse( message );
    } catch (err) {
      return 21;
    }

    const { endpoint, fetchOptions, errorCode } = fetchOptionsFromJsonRPCBody( jsonRPCBody, cashuRestMapper );

    if( errorCode !== undefined ) {
      return 21+errorCode;
    }

    const url = new URL(endpoint, this.restUrl);
    let response;
    try {
      response = await fetch( url.toString(), fetchOptions );
    } catch( err ) {
      return 10;
    }

    if( response.status === 200 ) {
      // that is good
      // post that back to nostr
      const bodyJSON = response.json();

      // construct JSON-RPC response
      const id = 'foo';
      const jsonRPCResponse = this.jsonRPCResponse(id, bodyJSON);

    } else {
      this.pool.publish(event, jsonRPCResponse)
    }

    return 1;
  }

  getSubscriptionConfig( publicKey ) {
    // get timestamp of latest received event. This is stored in kv
    const r = this.db.getLatestEventAt();
    if( r && parseInt(r.v) ) {
      // only get events we didn't process yet and future ones
      const latestEventAt = parseInt(r.v);
      // only listen to encrypted direct messages to me
      return { since: latestEventAt, kinds:[4], '#p': [publicKey]};
    } else {
      // get all past events, no limit and future ones
      // only listen to encrypted direct messages to me
      return { kinds:[4], '#p': [publicKey]};
    }
  }
}
