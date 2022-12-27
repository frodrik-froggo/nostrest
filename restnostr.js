const Restnostr = require('./lib/restnostr.js');
const {readJsonFile} = require('./lib/config');

( async() => {

  try {
    const config = await readJsonFile( './config.json' );
    const restnostr = new Restnostr( config.restnostr );
    await restnostr.start();
  } catch( err ) {
    console.error( err.toString() );
    process.exit( 1 );
  }

})();
