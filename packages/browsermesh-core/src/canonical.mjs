/**
 * canonical.mjs -- Deterministic, domain-separated signing payloads.
 *
 * Internal helper (not re-exported from index.mjs). Used by
 * SignedKeyLink, SignedKeyUnlink and signed CapabilityTokens so that every
 * signature this package produces:
 *
 * - is over a canonical encoding: JSON with object keys sorted (recursively),
 *   no whitespace, `undefined` object members omitted, and only finite
 *   numbers — so two implementations that agree on the value agree on the
 *   bytes, regardless of property insertion order;
 * - carries a domain prefix (`<namespace>/<type>/v<n>\n`) so a signature
 *   minted for one message type can never be replayed as another, even when
 *   the two bodies happen to encode identically.
 */

/**
 * Canonical JSON encoding with sorted keys.
 *
 * @param {*} value
 * @returns {string}
 */
export function canonicalize(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalize non-finite number: ${value}`);
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => {
          if (v === undefined) throw new TypeError('Cannot canonicalize undefined array element');
          return canonicalize(v);
        }).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('Can only canonicalize plain objects');
      }
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
  }
}

/**
 * Bytes to sign: `prefix ‖ canonicalize(body)`, UTF-8 encoded.
 *
 * @param {string} prefix - Domain prefix, ending in `\n`
 * @param {object} body
 * @returns {Uint8Array}
 */
export function domainPayload(prefix, body) {
  return new TextEncoder().encode(prefix + canonicalize(body));
}
