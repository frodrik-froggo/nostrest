const fsPromises = require( 'fs' ).promises;
const {getPublicKey} = require('nostr');
const secp256k1 = require('@noble/secp256k1');

module.exports = {

  readKeyFile: async ( keyFile ) => {
    // throws
    const privateKey = (await fsPromises.readFile( keyFile )).toString();
    const publicKey = getPublicKey(privateKey);
    return { privateKey, publicKey };
  },

  createRandomKeyFile: async ( keyFile ) => {
    const privateKey = Buffer.from(secp256k1.utils.randomPrivateKey()).toString('hex');
    await fsPromises.writeFile( keyFile, privateKey, {
      flag: 'w',
      mode: 0o600
    } );
    const publicKey = getPublicKey(privateKey);
    return { privateKey, publicKey };
  }

}