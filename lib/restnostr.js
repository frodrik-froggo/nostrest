const express = require('express')
const bodyParser = require('body-parser');
const NostrClient = require("./nostrclient");
const { v4: uuidv4 } = require('uuid');
const {decryptDm} = require("nostr");
const {fetchOptionsFromJsonRPCBody} = require("./toREST");

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
    this.onlySubscribeToEventsFrom = config.mintNostrPubkey;
    this.mintNostrPubkey = config.mintNostrPubkey;
    this.requestTimeoutSeconds = config.requestTimeoutSeconds || 30;
    this.host = config.host || 'localhost';
    this.port = config.port || '3888';
    this.app = express();
    this.setupMiddlewares();
    this.setupRoutes();
    this.jsonRPCResponses = {};
  }

  async start() {
    await super.start();
    this.app.listen(this.port, this.host, () => {
      console.log(`Restnostr listening on port ${this.port}`);
    });
  }

  async processEvent( event ) {
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
    this.jsonRPCResponses[jsonRPCBody.id] = jsonRPCBody;
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
    //const event = await this.compileNostrDMEvent( this.mintNostrPubkey, "Hello World!");
    //this.pool.send(["EVENT", event]);
    const jsonRPCBody = this.createJsonRPCBody( req.method.toLowerCase(), {
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
        clearTimeout( rt );
        if( jsonRPCResponse.result ) {
          const endpoint =  jsonRPCResponse.result.endpoint;
          const httpStatus =  jsonRPCResponse.result.httpStatus;
          const body =  jsonRPCResponse.result.body;
          res.status(httpStatus);
          if( body ) {
            res.send( body );
          } else {
            res.end();
          }
        } else if( jsonRPCResponse.error ) {
          res.status(502);
          res.end();
        }

        break;
      }
      await ( new Promise( (resolve) => { setTimeout(resolve,25); } ) );
    }
    res.end();
  }

  createJsonRPCBody( method, params) {
    return {
      jsonrpc: '2.0',
      id: uuidv4(),
      method,
      params
    }
  }
}
