const express = require('express')
const bodyParser = require('body-parser');
const {RelayPool} = require("nostr");
const {readKeyFile, createRandomKeyFile} = require("./keys");
const DB = require("./db");

module.exports = class Restnostr {

  constructor( config ) {
    this.host = config.host || 'localhost';
    this.port = config.port || '3888';
    this.mintNostrPubkey = config.mintNostrPubkey;
    this.relays = config.relays || [
      "wss://relay.damus.io",
      "wss://nostr-pub.wellorder.net",
      "wss://relay.nostr.info"
    ];
    this.app = express();
    this.setupMiddlewares();
    this.setupRoutes();
  }

  setupMiddlewares() {
    this.app.use(bodyParser.json());
  }

  setupRoutes() {
    this.handleGetKeys = this.handleGetKeys.bind(this);
    this.handleGetKeysets = this.handleGetKeysets.bind(this);
    this.handleGetMint = this.handleGetMint.bind(this);
    this.handlePostMint =  this.handlePostMint.bind(this);
    this.handlePostMelt = this.handlePostMelt.bind(this);
    this.handlePostCheck = this.handlePostCheck.bind(this);
    this.handlePostCheckfees = this.handlePostCheckfees.bind(this);
    this.handlePostSplit = this.handlePostSplit.bind(this);

    this.app.get('/keys', this.handleGetKeys );
    this.app.get('/keysets', this.handleGetKeysets );
    this.app.get('/mint', this.handleGetMint );
    this.app.post('/mint', this.handlePostMint );
    this.app.post('/melt', this.handlePostMelt );
    this.app.post('/check', this.handlePostCheck );
    this.app.post('/checkfees', this.handlePostCheckfees );
    this.app.post('/split', this.handlePostSplit );

  }

  async handleGetKeys( req, res ) {
    console.log( req.body );
    console.log( req.query );
    res.end();
  }

  async handleGetKeysets( req, res ) {
    console.log( req.body );
    console.log( req.query );
    res.end();
  }

  async handleGetMint( req, res ) {
    console.log( req.body );
    console.log( req.query );
    res.end();
  }

  async handlePostMint( req, res ) {
    console.log( req.body );
    console.log( req.query );
    res.end();
  }

  async handlePostMelt( req, res ) {
    console.log( req.body );
    console.log( req.query );
    res.end();
  }

  async handlePostCheck( req, res ) {
    console.log( req.body );
    console.log( req.query );
    res.end();
  }

  async handlePostCheckfees( req, res ) {
    console.log( req.body );
    console.log( req.query );
    res.end();
  }

  async handlePostSplit( req, res ) {
    console.log( req.body );
    console.log( req.query );
    res.end();
  }

  sendJSONRPC( jsonRPCBody, waitForAnswer = true, timeout = 30 ) {
    this.pool.send( 'hello');
  }

  compileNostrEvent() {
    /*
    {
      "id": "60f31301247d907900dec4727bbfe269393ba64f4c685e6d3713c31ada9918e6",
      "pubkey": "0df44616391f70e279dc071decce13ba3a4dd871e29587339ae970c0beb4e74e",
      "created_at": 1671383260,
      "kind": 4,
      "tags": [
      [
        "p",
        "8e70c70ceff84b8ff2b95bc35f12f766c24bca06256beb07846b736a0fa6cb99"
      ]
    ],
      "content": "jvfKUOLNEg7Ng0MfwJBJ5qx4cU/kl7KrVat23DWnzI0FpXow53h+XVvOh0z7gmTw1HZvnmg7Hu6aTYSoOWUDdImQq/EulwIyoWN/AKfeVweZC3fnG80wVRBgylq5WJs36EHxVkTQTqYyD0Phl3Qx5A==?iv=q6LHnz++WDFcbcK68OrwGA==",
      "sig": "468a89f894631a73fd38c6979cb5c4731da8651550d1cd26fb2c2a30b08e16a1452dd1d1381f9d3fb6ed8534cfab06c54414572b1b7caa8304ea7077908b68ec"
    }
  }
     */
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

    this.pool = RelayPool(this.relays);
    this.sendJSONRPC();
    this.pool.on('open', relay => {
      // subscribe to events in every relay we are connected to
      console.log( "connected to", relay.url);
    });

    this.app.listen(this.port, this.host, () => {
      console.log(`Restnostr listening on port ${this.port}`);
    });
  }
}
