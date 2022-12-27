const fsPromises = require( 'fs' ).promises;

module.exports = {
  readJsonFile: async (configFile) => {
    // throws
    return JSON.parse((await fsPromises.readFile( configFile )).toString());
  },
}