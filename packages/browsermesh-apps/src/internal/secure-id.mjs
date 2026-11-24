/**
 * secure-id.mjs -- identifiers that must not be guessable.
 *
 * Every id that matches a response to a request, or names a connection, comes
 * from the platform CSPRNG (`crypto.getRandomValues`). There is no fallback:
 * where the platform has none, creating an id fails with an error that says
 * so, rather than quietly producing something an observer could predict
 * (a clock reading plus a counter, or `Math.random`).
 *
 * An unguessable id is not the whole defence. A response is also accepted only
 * from the peer the request was sent to, and each site that waits for one
 * records that peer next to the id.
 */

function csprng() {
  const c = globalThis.crypto
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('No secure random source (crypto.getRandomValues) is available: refusing to create an identifier')
  }
  return c
}

/** @param {number} [bytes=16] @returns {string} `2 * bytes` lowercase hex characters */
export function randomHex(bytes = 16) {
  const buf = new Uint8Array(bytes)
  csprng().getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** An id that matches a response to a request: 128 random bits as 32 hex characters. */
export function randomRequestId() {
  return randomHex(16)
}

/** A version 4 UUID from the platform CSPRNG (`crypto.randomUUID` when it has one). */
export function randomUUID() {
  const c = csprng()
  if (typeof c.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  c.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
