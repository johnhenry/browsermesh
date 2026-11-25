/**
 * shard-parity.mjs -- Reed-Solomon erasure parity for StealthAgent state shards (format 3).
 *
 * Protects against LOST shards (any `k` of `k + m` rebuild the state), not forged ones: authenticity is the shard
 * signature, checked before a shard reaches the decoder. Unrelated to the Shamir key shares of `stealth-threshold.mjs`
 * (those split the group secret; this splits the state).
 *
 * Systematic code over GF(2^8), reduction polynomial 0x11d (x^8+x^4+x^3+x^2+1, the QR code field, generator 2) with a
 * Cauchy parity matrix: parity row `r` of `k` data shards is sum over c of inv((k + r) XOR c) * data_c. Every square
 * submatrix of a Cauchy matrix is invertible, so any `k` surviving shards decode. `k + m` is at most 64 here.
 *
 * Why this is hand-written rather than a dependency, and how it is checked: docs/design/discovery-records.md, item 2.
 */

/** The most shards (`k + m`) the code accepts. */
export const MAX_RS_SHARDS = 64

export class ParityError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message)
    this.name = 'ParityError'
    this.code = code
  }
}

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

/** Multiply in GF(2^8) (polynomial 0x11d). @param {number} a @param {number} b @returns {number} */
export function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]
}

/** Multiplicative inverse in GF(2^8). @param {number} a @returns {number} */
export function gfInv(a) {
  if (!Number.isInteger(a) || a < 1 || a > 255) throw new ParityError('bad-element', 'zero has no inverse in GF(2^8)')
  return EXP[255 - LOG[a]]
}

const cauchy = (k, r, c) => gfInv((k + r) ^ c)

function checkShape(k, m) {
  if (!Number.isInteger(k) || k < 1 || !Number.isInteger(m) || m < 0 || k + m > MAX_RS_SHARDS) {
    throw new ParityError('too-many-shards', `k + m must be at most ${MAX_RS_SHARDS} with k >= 1 and m >= 0`)
  }
}

/**
 * Parity shards for `k` equal-length data shards.
 * @param {Uint8Array[]} data - `k` shards, all the same length
 * @param {number} m - number of parity shards (0 returns none)
 * @returns {Uint8Array[]} `m` new parity shards, same length
 */
export function rsEncode(data, m) {
  if (!Array.isArray(data) || data.length === 0) throw new ParityError('bad-argument', 'data must be a non-empty list of Uint8Array')
  const k = data.length
  checkShape(k, m)
  const len = data[0].length
  if (!data.every((d) => d instanceof Uint8Array && d.length === len)) throw new ParityError('length-mismatch', 'every data shard must be a Uint8Array of the same length')
  const parity = []
  for (let r = 0; r < m; r++) {
    const row = new Uint8Array(len)
    for (let c = 0; c < k; c++) {
      const log = LOG[cauchy(k, r, c)]
      const src = data[c]
      for (let p = 0; p < len; p++) if (src[p] !== 0) row[p] ^= EXP[log + LOG[src[p]]]
    }
    parity.push(row)
  }
  return parity
}

/**
 * Rebuild the `k` data shards from any `k` of the `k + m` shards.
 * @param {Map<number, Uint8Array>} have - shard index (0..k-1 data, k..k+m-1 parity) to its bytes
 * @param {number} k
 * @param {number} m
 * @returns {Uint8Array[]} the `k` data shards (fresh buffers)
 */
export function rsDecode(have, k, m) {
  checkShape(k, m)
  if (!(have instanceof Map)) throw new ParityError('bad-argument', 'have must be a Map of index to bytes')
  let len = -1
  for (const [i, bytes] of have) {
    if (!Number.isInteger(i) || i < 0 || i >= k + m) throw new ParityError('bad-index', `shard index ${i} is outside 0..${k + m - 1}`)
    if (!(bytes instanceof Uint8Array)) throw new ParityError('bad-argument', 'shard bytes must be a Uint8Array')
    if (len === -1) len = bytes.length
    else if (bytes.length !== len) throw new ParityError('length-mismatch', 'shards differ in length')
  }
  if (have.size < k) throw new ParityError('too-few-shards', `need ${k} shards, have ${have.size}`)
  const idx = [...have.keys()].sort((a, b) => a - b).slice(0, k) // data shards sort first
  // Row j of the system: the coefficients that turn the k data shards into surviving shard idx[j].
  const mat = idx.map((i) => {
    const row = new Uint8Array(k)
    if (i < k) row[i] = 1
    else for (let c = 0; c < k; c++) row[c] = cauchy(k, i - k, c)
    return row
  })
  // Invert by Gauss-Jordan against the identity.
  const inv = idx.map((_, j) => { const row = new Uint8Array(k); row[j] = 1; return row })
  for (let col = 0; col < k; col++) {
    let piv = col
    while (piv < k && mat[piv][col] === 0) piv++
    if (piv === k) throw new ParityError('singular', 'the surviving shards are not independent') // cannot happen for distinct indices
    ;[mat[col], mat[piv]] = [mat[piv], mat[col]]
    ;[inv[col], inv[piv]] = [inv[piv], inv[col]]
    const scale = gfInv(mat[col][col])
    for (let j = 0; j < k; j++) { mat[col][j] = gfMul(mat[col][j], scale); inv[col][j] = gfMul(inv[col][j], scale) }
    for (let r = 0; r < k; r++) {
      if (r === col || mat[r][col] === 0) continue
      const f = mat[r][col]
      for (let j = 0; j < k; j++) { mat[r][j] ^= gfMul(f, mat[col][j]); inv[r][j] ^= gfMul(f, inv[col][j]) }
    }
  }
  const out = []
  for (let d = 0; d < k; d++) {
    const row = new Uint8Array(len)
    for (let j = 0; j < k; j++) {
      const coef = inv[d][j]
      if (coef === 0) continue
      const src = have.get(idx[j])
      const log = LOG[coef]
      for (let p = 0; p < len; p++) if (src[p] !== 0) row[p] ^= EXP[log + LOG[src[p]]]
    }
    out.push(row)
  }
  return out
}
