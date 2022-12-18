const methodConfigs = {
  keys: {
    httpMethod: 'GET',
    endpoint: '/keys',
  },
  keysets: {
    httpMethod: 'GET',
    endpoint: '/keysets'
  },
  requestMint: {
    httpMethod: 'GET',
    endpoint: '/mint',
    params: { amount: 'querystring' }
  },
  mint: {
    httpMethod: 'POST',
    endpoint: '/mint',
    params: {'payment_hash': 'querystring', 'blinded_messages': 'body' }
  },
  melt: {
    httpMethod: 'POST',
    endpoint: '/melt',
    params: {'proofs': 'body', 'invoice': 'body' }
  },
  check: {
    httpMethod: 'POST',
    endpoint: '/check',
    params: {'proofs': 'body'}

  },
  checkfees: {
    httpMethod: 'POST',
    endpoint: '/checkfees',
    params: {'pr': 'body'}
  },
  split: {
    httpMethod: 'POST',
    endpoint: '/split',
    params: {'proofs': 'body', 'amount': 'body', 'output_data': 'body', 'outputs': 'body'}
  },
}


module.exports = {
  cashuRestMapper: ( method, params ) => {

    const methodConfig = methodConfigs[method];

    if( !methodConfig ) {
      return {};
    }

    if( methodConfig.params && !(!!params) && (params.constructor === Object) ) {
      // need params, but no params object found
      return {};
    }

    const querystring = {};
    const body = {}
    for( const param in methodConfig.params ) {
      // check if we have the param
      if( !params.hasOwnProperty( param ) ) {
        // nope! bad :(
        return { err: 'missing parameter \''+param+'\''};
      }
      switch( methodConfig.params[param] ) {
        case 'body':
          body[param] = params[param];
          break;
        case 'querystring':
          querystring[param] = params[param];
          break;
      }
    }

    const httpMethod = methodConfig.httpMethod;
    let endpoint = methodConfig.endpoint;

    const options = {
      method: httpMethod,
      cache: 'no-cache',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
    };

    if( Object.keys(body).length ) {
      options.headers = {
        'Content-Type': 'application/json'
      };
      options.body = JSON.stringify(body) // body data type must
    }

    if( Object.keys(querystring).length) {
      endpoint+='?'+(new URLSearchParams(querystring));
    }

    return { endpoint, fetchOptions: options };
  }
}
