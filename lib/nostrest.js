const {RelayPool,decryptDm} = require('nostr')
const {readKeyFile,createRandomKeyFile} = require('./keys.js');
const {readConfigFile} = require('./config.js');
const {fetchOptionsFromJsonRPCBody, isJsonRPCRequest} = require('./toREST.js');
const NostrClient = require("./nostrclient");
const sqlite3 = require("better-sqlite3");

const statusCode = {
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

module.exports = class Nostrest extends NostrClient {

  constructor( config ) {
    super(config);
    this.restUrl = config.restUrl || 'http://127.0.0.1:8080';
    // will also act as a rate limite, since only one event is processed every update

    this.useTor = config.useTor || false;
    this.restOnion = config.restOnion;
  }

  async processEvent( event ) {
    // '{"jsonrpc":"2.0","id":"foo","method":"mint","params":{"payment_hash":"hash","blinded_messages":["one","two"]}}'
    let message, jsonRPCBody;
    try {
      message = decryptDm(this.myPrivateKey, event);
    } catch (err) {
      return 20;
    }
    console.log("Processing", event.id, message);

    try {
      jsonRPCBody = JSON.parse(message);
    } catch (err) {
      return 21;
    }

    const {endpoint, fetchOptions, errorCode} = fetchOptionsFromJsonRPCBody(jsonRPCBody);

    if (errorCode !== undefined) {
      return 21 + errorCode;
    }

    const url = new URL(endpoint, this.restUrl);
    let response;
    try {
      response = await fetch(url.toString(), fetchOptions);
    } catch (err) {
      console.error("REST: Connection refused");
    }
    // that is good
    // post that back to nostr
    let result, error;
    if (response) {
      result = {
        endpoint: endpoint,
        httpStatus: response.status,
        body: await response.json()
      };
    } else {
      error = this.jsonRPCResponseError(11, "connection refused");
    }
    const jsonRPCResponse = this.createJsonRPCResponse(jsonRPCBody.id, result, error);
    await this.sendToNostr( event.pubkey, jsonRPCResponse );

    return !!result?0:11;
  }

}
