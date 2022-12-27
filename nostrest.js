// priv: 0263273ff3c8a10eadbab54949d2b273d59b3f4b1d62ac5f54880e6184738341
// pub: 0df44616391f70e279dc071decce13ba3a4dd871e29587339ae970c0beb4e74e

// https://www.npmjs.com/package/tor-request

const Nostrest = require('./lib/nostrest.js');
const {readJsonFile} = require('./lib/config');

( async() => {

  try {
    const config = await readJsonFile( './config.json' );
    const nostrest = new Nostrest( config.nostrest );
    await nostrest.start();
  } catch( err ) {
    console.error( err.toString() );
    process.exit( 1 );
  }

})();
