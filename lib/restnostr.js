const express = require('express')
const bodyParser = require('body-parser');
const NostrClient = require('./nostrclient');
const { v4: uuidv4 } = require('uuid');
const {decryptDm,Relay} = require('nostr');
const {requestOptionsFromJsonRPCBody, isJsonRPCResponse} = require('./toREST');

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

module.exports = class Restnostr extends NostrClient {

  constructor( config ) {
    super(config);
    this.isListening = false;
    this.mintNostrPubkey = config.mintNostrPubkey;
    this.onlySubscribeToEventsFrom = [this.mintNostrPubkey];
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

    const subscriptionConfig = this.getSubscriptionConfig();

    this.pool.on('open', relay => {
      relay.subscribe(this.dataSubid, subscriptionConfig);

      /*
      relay.ws.on('open', function open() {
        console.log('connected');
      });

      relay.ws.on('close', function close() {
        console.log('disconnected');
      });

      relay.ws.on('message', function incoming(message) {
        console.log('received: %s', message);
      });

      relay.ws.on('pong', function incoming() {
        console.log('pong');
      })
       */
    });

    for( const relayUrl of this.relayUrls ) {
      console.log( 'adding',relayUrl);
      this.pool.add(new Relay(relayUrl));
    }

    await this.sendToNostr( this.mintNostrPubkey, this.createJsonRPCBody( 'HENLO' ) );
  }

  async processItsme( result ) {
    // this is called after receiving an event with
    // a method which is not a http method

    // TODO: implement random discovery when default relay is down

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
    try {
      message = decryptDm( this.myPrivateKey, event );
    } catch ( err) {
      return 20;
    }
    console.log( 'Processing', event.kind, message );

    try {
      jsonRPCBody = JSON.parse( message );
    } catch (err) {
      return 21;
    }

    if( isJsonRPCResponse( jsonRPCBody ) ) {
      if( jsonRPCBody.result && jsonRPCBody.result.verb && jsonRPCBody.result.verb.toLowerCase() === 'itsme' ) {
        // only process itsme from ephemeral DMs
        await this.processItsme( jsonRPCBody.result );
        return 0;
      }
      this.jsonRPCResponses[jsonRPCBody.id] = { jsonRPCResultBody: jsonRPCBody, eventId: event.id };

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
    await this.sendToNostr( this.mintNostrPubkey, jsonRPCBody );
    let timedOut = false;
    let rt = setTimeout( () => {
      timedOut = true;
    }, this.requestTimeoutSeconds*1000 );

    while( !timedOut ) {
      const jsonRPCResponse = this.jsonRPCResponses[jsonRPCBody.id];
      if( jsonRPCResponse ) {
        const { jsonRPCResultBody, eventId } = jsonRPCResponse;
        clearTimeout( rt );
        if( jsonRPCResultBody.result ) {
          const endpoint =  jsonRPCResultBody.result.endpoint;
          const httpStatus =  jsonRPCResultBody.result.httpStatus;
          const body =  jsonRPCResultBody.result.body;
          await this.sendToNostr( this.mintNostrPubkey, this.createJsonRPCBody( 'GOTIT', {eventId} ) );
          // TODO: the event with the id message.eventId is no longer interesting for me. Cleanup
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
