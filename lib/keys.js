const fsPromises = require( 'fs' ).promises;
const {getPublicKey} = require('nostr');
const secp256k1 = require('@noble/secp256k1');

const e = {

  readKeyFile: async ( keyFile ) => {
    // throws
    const privateKey = (await fsPromises.readFile( keyFile )).toString();
    const publicKey = getPublicKey(privateKey);
    return { privateKey, publicKey };
  },

  createRandomKeyFile: async ( keyFile ) => {
    const keyPair = e.createRandomKeyPair();
    await fsPromises.writeFile( keyFile, keyPair.privateKey, {
      flag: 'w',
      mode: 0o600
    } );
    return keyPair;
  },

  createRandomKeyPair: () => {
    const privateKey = Buffer.from(secp256k1.utils.randomPrivateKey()).toString('hex');
    const publicKey = getPublicKey(privateKey);
    return { privateKey, publicKey };
  }

}

module.exports = e;