// Run with: node --import ./test/_setup-globals.mjs --test test/shard-parity.test.mjs
// Reed-Solomon erasure code over GF(2^8) (docs/design/discovery-records.md, item 2).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rsEncode, rsDecode, gfMul, gfInv, ParityError, MAX_RS_SHARDS } from '../src/shard-parity.mjs'

// -- the field, against published values (ISO/IEC 18004 Annex, the QR code field: x^8+x^4+x^3+x^2+1 = 0x11d, generator 2)
const QR_ANTILOG_START = [1, 2, 4, 8, 16, 32, 64, 128, 29, 58, 116, 232, 205, 135, 19, 38, 76, 152, 45, 90, 180, 117, 234, 201, 143, 3]

// -- a second implementation used only here: shift-and-xor multiplication, brute-force inverse, Gauss-Jordan on an
//    augmented matrix, parity rows built straight from the definition in the design note.
function refMul(a, b) {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const carry = a & 0x80
    a = (a << 1) & 0xff
    if (carry) a ^= 0x1d
    b >>= 1
  }
  return p
}
function refInv(a) {
  for (let b = 1; b < 256; b++) if (refMul(a, b) === 1) return b
  throw new Error('no inverse')
}
const refCauchy = (k, r, c) => refInv((k + r) ^ c)
function refEncode(data, m) {
  const k = data.length
  const len = data[0].length
  const out = []
  for (let r = 0; r < m; r++) {
    const row = new Uint8Array(len)
    for (let c = 0; c < k; c++) {
      const coef = refCauchy(k, r, c)
      for (let p = 0; p < len; p++) row[p] ^= refMul(coef, data[c][p])
    }
    out.push(row)
  }
  return out
}
/** Solve for the k data shards from any k shards (index -> bytes) by Gauss-Jordan on [matrix | shard bytes]. */
function refDecode(have, k) {
  const idx = [...have.keys()].slice(0, k)
  const len = have.get(idx[0]).length
  const rows = idx.map((i) => {
    const coefs = new Array(k).fill(0)
    if (i < k) coefs[i] = 1
    else for (let c = 0; c < k; c++) coefs[c] = refCauchy(k, i - k, c)
    return { coefs, bytes: Uint8Array.from(have.get(i)) }
  })
  for (let col = 0; col < k; col++) {
    let piv = col
    while (rows[piv].coefs[col] === 0) piv++
    ;[rows[col], rows[piv]] = [rows[piv], rows[col]]
    const inv = refInv(rows[col].coefs[col])
    rows[col].coefs = rows[col].coefs.map((v) => refMul(v, inv))
    rows[col].bytes = rows[col].bytes.map((v) => refMul(v, inv))
    for (let r = 0; r < k; r++) {
      if (r === col || rows[r].coefs[col] === 0) continue
      const f = rows[r].coefs[col]
      rows[r].coefs = rows[r].coefs.map((v, j) => v ^ refMul(f, rows[col].coefs[j]))
      for (let p = 0; p < len; p++) rows[r].bytes[p] ^= refMul(f, rows[col].bytes[p])
    }
  }
  return rows.map((r) => r.bytes)
}

const sample = (k, len, seed = 1) => Array.from({ length: k }, (_, c) => Uint8Array.from({ length: len }, (_, p) => (seed * 131 + c * 17 + p * 29 + (p * p) % 251) & 0xff))
const subsets = (n, size) => {
  const out = []
  const walk = (start, acc) => {
    if (acc.length === size) { out.push([...acc]); return }
    for (let i = start; i < n; i++) { acc.push(i); walk(i + 1, acc); acc.pop() }
  }
  walk(0, [])
  return out
}

describe('GF(2^8), polynomial 0x11d', () => {
  it('matches the published antilog table and its endpoints', () => {
    let x = 1
    for (let i = 0; i < QR_ANTILOG_START.length; i++) { assert.equal(x, QR_ANTILOG_START[i], `alpha^${i}`); x = gfMul(x, 2) }
    let p = 1
    for (let i = 0; i < 255; i++) p = gfMul(p, 2)
    assert.equal(p, 1, 'alpha^255 = 1')
    assert.equal(gfInv(2), 142, 'the inverse of 2 is alpha^254 = 142 (published)')
    assert.equal(gfMul(0x80, 2), 0x1d)
    assert.equal(gfMul(3, 7), 9)
  })

  it('agrees with an independent multiplier on every pair and inverts every non-zero element', () => {
    for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) assert.equal(gfMul(a, b), refMul(a, b))
    for (let a = 1; a < 256; a++) assert.equal(gfMul(a, gfInv(a)), 1)
    assert.throws(() => gfInv(0), ParityError)
  })
})

describe('Reed-Solomon parity', () => {
  it('produces the same parity bytes as an independent implementation built from the definition', () => {
    for (const [k, m, len] of [[1, 1, 5], [2, 1, 9], [3, 2, 16], [4, 4, 33], [10, 6, 7]]) {
      const data = sample(k, len, k + m)
      assert.deepEqual(rsEncode(data, m), refEncode(data, m), `k=${k} m=${m}`)
    }
  })

  it('a fixed, hand-checkable vector: k=2, m=1 parity is inv(2^2) * d0 + inv(2^3) * d1', () => {
    // x_0 = k + 0 = 2; y = 0, 1; coefficients inv(2 ^ 0) = inv(2) = 142, inv(2 ^ 1) = inv(3)
    const [p] = rsEncode([Uint8Array.of(1, 0), Uint8Array.of(0, 1)], 1)
    assert.deepEqual([...p], [gfInv(2), gfInv(3)])
    assert.equal(gfInv(2), 142)
  })

  it('every set of k of the k + m shards rebuilds the data (the code is MDS), for several shapes', () => {
    for (const [k, m] of [[1, 2], [2, 2], [3, 2], [3, 3], [4, 3], [5, 4]]) {
      const data = sample(k, 12, k * 7 + m)
      const parity = rsEncode(data, m)
      const all = [...data, ...parity]
      for (const keep of subsets(k + m, k)) {
        const have = new Map(keep.map((i) => [i, all[i]]))
        assert.deepEqual(rsDecode(have, k, m), data, `k=${k} m=${m} keep=${keep}`)
        assert.deepEqual(refDecode(have, k), data, 'the second implementation agrees')
      }
    }
  })

  it('refuses too few shards, mismatched lengths, an index out of range and shapes beyond the cap', () => {
    const data = sample(3, 8)
    const parity = rsEncode(data, 2)
    assert.throws(() => rsDecode(new Map([[0, data[0]], [4, parity[1]]]), 3, 2), (e) => e instanceof ParityError && e.code === 'too-few-shards')
    assert.throws(() => rsDecode(new Map([[0, data[0]], [1, data[1]], [4, parity[1].slice(1)]]), 3, 2), (e) => e instanceof ParityError && e.code === 'length-mismatch')
    assert.throws(() => rsDecode(new Map([[0, data[0]], [1, data[1]], [9, parity[1]]]), 3, 2), (e) => e instanceof ParityError && e.code === 'bad-index')
    assert.throws(() => rsEncode(data, MAX_RS_SHARDS), (e) => e instanceof ParityError && e.code === 'too-many-shards')
    assert.throws(() => rsEncode([data[0], data[1].slice(1)], 1), (e) => e instanceof ParityError && e.code === 'length-mismatch')
    assert.deepEqual(rsEncode(data, 0), [])
  })

  it('does not change its inputs and returns fresh buffers', () => {
    const data = sample(3, 8)
    const copy = data.map((d) => Uint8Array.from(d))
    const parity = rsEncode(data, 2)
    assert.deepEqual(data, copy)
    const out = rsDecode(new Map([[0, data[0]], [1, data[1]], [3, parity[0]]]), 3, 2)
    out[0][0] ^= 0xff
    assert.deepEqual(data, copy)
  })
})
