const VALID_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const e = {
  defaultMapper: ( method, params ) => {

    method = method.toUpperCase();

    if( VALID_METHODS.findIndex( item => item === method ) === -1 ) {
      return {};
    }

    const paramsIsObject = (!!params) && (params.constructor === Object);

    if( !paramsIsObject ) {
      return {};
    }

    let endpoint = params.endpoint;
    if( !endpoint ) {
      return {};
    }

    const query = params.query || {};
    const body  = params.body || {};

    const options = {
      method: method, // *GET, POST, PUT, DELETE, etc.
      cache: 'no-cache', // *default, no-cache, reload, force-cache, only-if-cached
      redirect: 'follow', // manual, *follow, error
      referrerPolicy: 'no-referrer', // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
    };

    if( Object.keys(body).length ) {
      options.headers = {
        'Content-Type': 'application/json'
      };
      options.body = JSON.stringify(body) // body data type must
    }

    if( Object.keys(query).length) {
      endpoint+='?'+(new URLSearchParams(querystring));
    }

    return { endpoint: endpoint, fetchOptions: options };
  },

  fetchOptionsFromJsonRPCBody: (jsonRPCBody, mapper ) => {
    if( !jsonRPCBody ) {
      return { errorCode: 0 }; // ugly
    }
    mapper = mapper || e.defaultMapper;

    if( !jsonRPCBody.method ) {
      return { errorCode: 1 };
    }

    if( !jsonRPCBody.id ) {
      return { errorCode: 2 };
    }

    const mapperResult = mapper( jsonRPCBody.method, jsonRPCBody.params );

    if( !mapperResult.endpoint || !mapperResult.fetchOptions ) {
      return { errorCode: 3 };
    }

    return mapperResult;

  },

  isJsonRPCRequest(jsonRPCBody ) {

    if( !jsonRPCBody.method || !jsonRPCBody.id ) {
      return false;
    }

    return true;
  },

  isJsonRPCResponse(jsonRPCBody ) {

    if( !jsonRPCBody.id || !( jsonRPCBody.result || jsonRPCBody.error ) ) {
      return false;
    }

    return true;
  }

}

module.exports = e;
