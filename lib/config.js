const fsPromises = require( 'fs' ).promises;

module.exports = {
  readConfigFile: async ( configFile) => {
    // throws
    return JSON.parse((await fsPromises.readFile( configFile )).toString());
  }
}