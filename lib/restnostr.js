const express = require('express')
const bodyParser = require('body-parser');
const NostrClient = require('./nostrClient.js');
const { v4: uuidv4 } = require('uuid');
const {decryptDm,Relay} = require('nostr');
const {createRandomKeyPair} = require('./keys.js');

const {requestOptionsFromJsonRPCBody, isJsonRPCResponse} = require('./toREST');

const statusCode = {
  0: 'ok',
  20: 'no key',
  21: 'bad decrypt',
  22: 'invalid json'
};

// TODO: implement random discovery of mint relay, after default relay connection fails

module.exports = class Restnostr extends NostrClient {

  constructor( config ) {
    super(config);
    this.isListening = false;
    this.mintNostrPubkey = config.mintNostrPubkey;
    this.onlySubscribeToEventsFrom = [this.mintNostrPubkey];
    this.subids = {};
    this.requestTimeoutSeconds = config.requestTimeoutSeconds || 30;
    this.host = config.host || 'localhost';
    this.port = config.port || '3888';
    this.app = express();
    this.setupMiddlewares();
    this.setupRoutes();
    this.jsonRPCResponses = {};
    this.processingItsme = false;
  }

  async bootstrap() {
    this.relayUrls = await this.chooseRelayUrls( this.minRelays );

    // subscription for per to peer
    const subscriptionConfig = this.getSubscriptionConfig(this.staticPublicKey);

    this.pool.on('open', async relay => {
      await relay.subscribe(this.dataSubid, subscriptionConfig);
      //relay.ws.on('message',  (m) => {
      //  console.log( m.toString() );
      //});
    });

    for( const relayUrl of this.relayUrls ) {
      console.log( 'adding',relayUrl);
      this.pool.add(new Relay(relayUrl));
    }

    const keyPair = createRandomKeyPair();
    this.setKeyPair( keyPair.publicKey, keyPair.privateKey ); // will be used in decrypt by NostrClient
    const subid = uuidv4();
    this.subids[keyPair.publicKey] = subid;
    await this.pool.subscribe( subid, this.getSubscriptionConfig(keyPair.publicKey, this.mintNostrPubkey));
    console.log( "sending henlo");
    await this.sendToNostr( keyPair.publicKey, keyPair.privateKey, this.mintNostrPubkey, this.createJsonRPCBody( 'HENLO' ) );
  }

  async processItsme( result ) {
    // this is called after receiving an event with
    // a method which is not a http method

    // remove old relays
    for( const relayUrl of this.relayUrls ) {
      this.pool.remove(relayUrl);
    }

    this.relayUrls = result.relays;

    // add new relays
    for( const relayUrl of this.relayUrls ) {
      console.log( 'adding',relayUrl);
      this.pool.add(new Relay(relayUrl));
    }

    // now we should have a maximum common relays
    if( !this.isListening ) {
      this.isListening = true;
      this.app.listen(this.port, this.host, () => {
        console.log(`Restnostr listening on port ${this.port}`);
      });
    }

  }

  async processEvent( event ) {
    // this is called from update();
    let message, jsonRPCBody;
    const recipientPublicKey = this.getRecipient(event);
    const privateKey = this.getPrivateKey( recipientPublicKey );

    if( !privateKey ) {
      console.error('no key');
      return 20;
    }

    try {
      message = decryptDm( privateKey, event );
    } catch ( err) {
      console.error('bad decrypt');
      return 21;
    }
    console.log( 'Processing', event.kind, message );

    try {
      jsonRPCBody = JSON.parse( message );
    } catch (err) {
      console.error('bad json');
      return 22;
    }

    if( this.subids[recipientPublicKey] ) {
      await this.pool.unsubscribe(this.subids[recipientPublicKey]);
      delete this.subids[recipientPublicKey];
    }

    if( isJsonRPCResponse( jsonRPCBody ) ) {
      if( jsonRPCBody.result && jsonRPCBody.result.verb && jsonRPCBody.result.verb.toLowerCase() === 'itsme' ) {
        // only process itsme from ephemeral DMs
        await this.processItsme( jsonRPCBody.result );
        this.deleteKeyPair(recipientPublicKey);
        return 0;
      }
      this.jsonRPCResponses[jsonRPCBody.id] = { eventId: event.id, jsonRPCResultBody: jsonRPCBody };
    }
    return 0;
  }

  setupMiddlewares() {
    this.app.use(bodyParser.json());
  }

  setupRoutes() {
    this.handleEndpoint = this.handleEndpoint.bind(this);
    this.app.use( this.handleEndpoint );
  }

  async handleEndpoint( req, res ) {
    //const event = await this.compileNostrDMEvent( this.mintNostrPubkey, 'Hello World!');
    //this.pool.send(['EVENT', event]);
    const jsonRPCBody = this.createJsonRPCBody( req.method.toUpperCase(), {
      endpoint: req.url,
      query: req.params,
      body: req.body
    });
    // TODO:
    //  1) generate ephemeral key pair
    const keyPair = createRandomKeyPair();
    const publicKey = keyPair.publicKey;
    const privateKey = keyPair.privateKey;
    this.setKeyPair( publicKey, privateKey ); // will be used in decrypt by NostrClient

    //const publicKey = this.staticPublicKey;
    //const privateKey = this.staticPrivateKey;

    //  2) subscribe to ephemeral pub key as receiver
    const subid = uuidv4();
    const subscriptionConfig = this.getSubscriptionConfig(publicKey, this.mintNostrPubkey);
    await this.pool.subscribe( subid, subscriptionConfig);
    //  3) send event with this key pair
    const requestEventId = await this.sendToNostr( publicKey, privateKey, this.mintNostrPubkey, jsonRPCBody );
    let timedOut = false;
    let rt = setTimeout( () => {
      timedOut = true;
    }, this.requestTimeoutSeconds*1000 );

    while( !timedOut ) {
      //  4) wait for response
      const entry = this.jsonRPCResponses[jsonRPCBody.id];
      if( entry ) {
        const {jsonRPCResultBody, eventId} = entry;
        clearTimeout( rt );
        if( jsonRPCResultBody.result ) {
          const endpoint =  jsonRPCResultBody.result.endpoint;
          const httpStatus =  jsonRPCResultBody.result.httpStatus;
          const body =  jsonRPCResultBody.result.body;
          await this.sendToNostr( publicKey, privateKey, this.mintNostrPubkey, this.createJsonRPCBody( 'GOTIT', {eventId: requestEventId} ) );
          //  5) unsubscribe to ephemeral pub key as receiver
          await this.pool.unsubscribe(subid);
          this.deleteKeyPair(publicKey); // no longer needed

          res.status(httpStatus);
          if( body ) {
            res.send( body );
          } else {
            res.end();
          }
        } else if( jsonRPCResultBody.error ) {
          res.status(502);
          res.end();
        }

        break;
      }
      await ( new Promise( (resolve) => { setTimeout(resolve,25); } ) );
    }
    res.end();
  }
}
