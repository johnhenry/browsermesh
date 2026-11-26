/**
 * shard-format.mjs -- the byte-level pieces of shard format 3 (checksum, split, join).
 *
 * Format 3 is what `StealthAgent` writes when its `shardFormat` option includes 3: base64url byte shards, a SHA-256 checksum, and
 * Reed-Solomon (or XOR) parity, stored under key names older peers never read. Design and interoperation:
 * docs/design/discovery-records.md, items 1 and 2.
 */
import { rsEncode, rsDecode, MAX_RS_SHARDS } from './shard-parity.mjs'

/** The most state bytes a format-3 write accepts (and a format-3 record may declare). */
export const MAX_STATE_BYTES = 8 * 1024 * 1024
/** The most shards (data plus parity) a format-3 write accepts. */
export const MAX_SHARDS = MAX_RS_SHARDS
export const PARITY_CODES = ['rs', 'xor']

const CHECKSUM_DOMAIN = 'browsermesh-stealth/shard-checksum/3'
const CHECKSUM_PREFIX = 's256.'
const te = new TextEncoder()

export function toBase64Url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
const B64U_RE = /^[A-Za-z0-9_-]*$/
export function fromBase64Url(str) {
  if (typeof str !== 'string' || !B64U_RE.test(str) || str.length % 4 === 1) throw new TypeError('not base64url')
  const bin = atob(str.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (str.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
/** Length-prefixed concatenation: no two different field lists encode to the same bytes. */
function frame(...parts) {
  const chunks = parts.map((p) => (typeof p === 'string' ? te.encode(p) : p))
  const out = new Uint8Array(chunks.reduce((n, c) => n + 4 + c.length, 0))
  let at = 0
  for (const c of chunks) { out.set(u32(c.length), at); at += 4; out.set(c, at); at += c.length }
  return out
}

/**
 * The format-3 shard checksum: `"s256." + base64url(SHA-256(...))`, the whole digest, over a domain label and, each
 * length-prefixed, the shard index, the data-shard count, the total shard count, the parity code, the state byte length and
 * the shard's bytes. It does not include the agent id (an anonymous record stores none).
 *
 * @param {{ index: number, threshold: number, total: number, code: string, len: number, bytes: Uint8Array }} shard
 * @returns {Promise<string>}
 */
export async function stealthShardChecksum({ index, threshold, total, code, len, bytes }) {
  const digest = await crypto.subtle.digest('SHA-256', frame(CHECKSUM_DOMAIN, String(index), String(threshold), String(total), code, String(len), bytes))
  return CHECKSUM_PREFIX + toBase64Url(new Uint8Array(digest))
}

/** Whether `s` has the shape of a format-3 checksum (checked before any hashing). */
export const isChecksum3 = (s) => typeof s === 'string' && s.length === CHECKSUM_PREFIX.length + 43 && s.startsWith(CHECKSUM_PREFIX) && B64U_RE.test(s.slice(CHECKSUM_PREFIX.length))

/** Bytes per shard for a state of `len` bytes cut into `k` shards. */
export const shardBytes = (len, k) => Math.max(1, Math.ceil(len / k))

/**
 * Cut a state string into `k` data shards and `total - k` parity shards.
 * @param {string} blob - well-formed UTF-16 (no lone surrogates; the caller checks)
 * @param {number} k - data shards
 * @param {number} total - data plus parity shards
 * @param {'rs'|'xor'} code
 * @returns {{ len: number, shards: Uint8Array[] }} `total` shards of equal length; `len` is the UTF-8 byte length of the state
 */
export function splitState3(blob, k, total, code) {
  const bytes = te.encode(blob)
  const size = shardBytes(bytes.length, k)
  const data = []
  for (let i = 0; i < k; i++) {
    const shard = new Uint8Array(size)
    shard.set(bytes.subarray(i * size, Math.min(bytes.length, (i + 1) * size)))
    data.push(shard)
  }
  const m = total - k
  let parity
  if (code === 'rs') parity = rsEncode(data, m)
  else {
    const x = new Uint8Array(size)
    for (const d of data) for (let p = 0; p < size; p++) x[p] ^= d[p]
    parity = Array.from({ length: m }, () => Uint8Array.from(x))
  }
  return { len: bytes.length, shards: [...data, ...parity] }
}

/**
 * Rebuild the state string from at least `k` shards of one write.
 * @param {Map<number, Uint8Array>} have - shard index to bytes
 * @returns {string}
 * @throws {Error} when the shards cannot rebuild the state (`code`: too-few-shards, not-well-formed, ...)
 */
export function joinState3(have, k, total, code, len) {
  let data
  if (code === 'rs') data = rsDecode(have, k, total - k)
  else {
    data = []
    const missing = []
    for (let i = 0; i < k; i++) { if (have.has(i)) data[i] = have.get(i); else missing.push(i) }
    if (missing.length > 1) throw Object.assign(new Error('parity of this code recovers one data shard'), { code: 'too-few-shards' })
    if (missing.length === 1) {
      let parity = null
      for (let i = k; i < total; i++) if (have.has(i)) { parity = have.get(i); break }
      if (!parity) throw Object.assign(new Error('no parity shard to recover from'), { code: 'too-few-shards' })
      const rec = Uint8Array.from(parity)
      for (const d of data) if (d) for (let p = 0; p < rec.length; p++) rec[p] ^= d[p]
      data[missing[0]] = rec
    }
  }
  const out = new Uint8Array(data.length * data[0].length)
  data.forEach((d, i) => out.set(d, i * d.length))
  try { return new TextDecoder('utf-8', { fatal: true }).decode(out.subarray(0, len)) } catch { throw Object.assign(new Error('the rebuilt state is not valid UTF-8'), { code: 'not-well-formed' }) }
}
