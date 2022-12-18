const {RelayPool,decryptDm} = require('nostr')
const DB = require('./db.js');
const {readKeyFile,createRandomKeyFile} = require('./keys.js');
const {fetchOptionsFromJsonRPCBody, isJSONRPC} = require('./toREST.js');

module.exports = class NostrClient {

  constructor( config ) {
    this.dbFile = config.nostr.dbFile || './client_state.sqlite3';
    this.privateKeyFile = config.nostr.privateKeyFile || './client_privateKey.txt';
    this.relays = config.nostr.relays || [
      "wss://relay.damus.io",
      "wss://nostr-pub.wellorder.net",
      "wss://relay.nostr.info"
    ];

    this.onEvent = this.onEvent.bind(this);
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

    // connect to all relays
    this.pool = RelayPool(this.relays);

    // get the subscription config
    const subscriptionConfig = this.getSubscriptionConfig(this.myPublicKey);

    this.pool.on('open', relay => {
      // subscribe to events in every relay we are connected to
      relay.subscribe("subid", subscriptionConfig);
    });

    this.pool.on('event', this.onEvent );
  }

  onEvent( relay, sub_id, event ) {

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
