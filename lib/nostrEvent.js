const crypto = require('crypto');
const secp256k1 = require('@noble/secp256k1');

const e = {
  serializeEvent: (event) => {
    return JSON.stringify([
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content
    ])
  },
  getEventHash: (event) => {
    let eventHash = crypto.createHash('sha256')
      .update(Buffer.from(e.serializeEvent(event)))
      .digest()
    return Buffer.from(eventHash).toString('hex')
  },
  validateEvent: (event) => {
    if (event.id !== e.getEventHash(event)) return false
    if (typeof event.content !== 'string') return false
    if (typeof event.created_at !== 'number') return false

    if (!Array.isArray(event.tags)) return false
    for (const tags of event.tags) {
      if (!Array.isArray(tags)) return false
      for (const tag of tags) {
        if (typeof tag === 'object') return false
      }
    }

    return true
  },
  verifySignature: (event) => {
    return secp256k1.schnorr.verify(event.sig, event.id, event.pubkey)
  },
  signEvent: async (event, key) => {
    return Buffer.from(
      await secp256k1.schnorr.sign(e.getEventHash(event), key)
    ).toString('hex')
  }
};

module.exports = e;
