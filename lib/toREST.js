const e = {
  defaultMapper: ( method, params ) => {
    const paramsIsObject = (!!params) && (params.constructor === Object);
    const paramsIsArray = Array.isArray( params );
    const usePost =  paramsIsArray || paramsIsObject;

    const options = {
      method:  usePost?'POST':'GET', // *GET, POST, PUT, DELETE, etc.
      cache: 'no-cache', // *default, no-cache, reload, force-cache, only-if-cached
      redirect: 'follow', // manual, *follow, error
      referrerPolicy: 'no-referrer', // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
    };

    if( usePost ) {
      options.headers = {
        'Content-Type': 'application/json'
      };
      options.body = JSON.stringify(params) // body data type must
    }

    return { endpoint: '/'+encodeURIComponent(method),fetchOptions: options };
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

  isJSONRPC( jsonString ) {

    let jsonRPCBody;

    try {
      jsonRPCBody = JSON.parse( jsonString );
    } catch (_) {
      return false;
    }

    if( !jsonRPCBody.method || !jsonRPCBody.id ) {
      return false;
    }

    return true;
  }
}

module.exports = e;
