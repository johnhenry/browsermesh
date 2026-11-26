// An "old peer": implements exactly the shard rules of browsermesh-discovery 0.5.0 (format 2), written out
// independently of src/stealth.mjs so the new code can be tested against what an older release does. It reads
// and writes ONLY the format-2 keys, checks the char-code sum the way the old collector did, and has no idea a
// `shard3` key or a `v: 3` record exists. test/stealth-shard-format.test.mjs also proves this double and the
// current module agree on format 2, so the double is not drifting from the thing it stands in for.
import { createHash } from 'node:crypto'

const b64u = (bytes) => Buffer.from(bytes).toString('base64url')
const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const sum = (s) => { let n = 0; for (let i = 0; i < s.length; i++) n = (n + s.charCodeAt(i)) >>> 0; return n }

export class LegacyStealthPeer {
  #agentId; #dht; #identity; #nonce; #k; #n; #seq = 0; #trusted
  stats = { shardUnsigned: 0, shardBadSignature: 0, shardStale: 0, shardMalformed: 0 }

  constructor({ agentId, dhtNode, identity, lookupNonce = null, threshold = 3, totalShards = 5, trustedKeys = [] }) {
    this.#agentId = agentId; this.#dht = dhtNode; this.#identity = identity; this.#nonce = lookupNonce
    this.#k = threshold; this.#n = totalShards; this.#trusted = trustedKeys
  }

  #keys() {
    return Array.from({ length: this.#n }, (_, i) => this.#nonce === null
      ? `stealth:${this.#agentId}:shard:${i}`
      : sha256Hex(`browsermesh-stealth/lookup/1\0${this.#agentId}\0${this.#nonce}\0${i}`))
  }

  #text({ key, i, seq, checksum, data }) {
    return `browsermesh-stealth-shard/1\nagent:${this.#agentId}\nkey:${key}\nindex:${i}\nseq:${seq}\nthreshold:${this.#k}\ntotal:${this.#n}\nchecksum:${checksum}\nnonce:${this.#nonce ?? ''}\ndata:${sha256Hex(data)}`
  }

  async hideSigned(blob) {
    const size = Math.ceil(blob.length / this.#k)
    const chunks = Array.from({ length: this.#k }, (_, i) => blob.slice(i * size, i * size + size).padEnd(size, '\0'))
    let parity = ''
    for (let c = 0; c < size; c++) { let x = 0; for (const ch of chunks) x ^= ch.charCodeAt(c); parity += String.fromCharCode(x) }
    const all = [...chunks, ...Array.from({ length: this.#n - this.#k }, () => parity)]
    const keys = this.#keys()
    const seq = Math.max(this.#seq + 1, Date.now())
    for (let i = 0; i < all.length; i++) {
      const checksum = sum(all[i])
      const sig = b64u(new Uint8Array(await this.#identity.sign(new TextEncoder().encode(this.#text({ key: keys[i], i, seq, checksum, data: all[i] })))))
      this.#dht.store(keys[i], this.#nonce === null
        ? { shardId: `${this.#agentId}:shard:${i}`, agentId: this.#agentId, data: all[i], threshold: this.#k, total: this.#n, checksum, v: 2, i, seq, sig }
        : { v: 2, i, data: all[i], checksum, seq, sig })
    }
    this.#seq = seq
    return { seq, keys }
  }

  async reconstituteSigned() {
    const keys = this.#keys()
    const signers = [new Uint8Array(await this.#identity.rawPublicKey()), ...this.#trusted]
    const bySeq = new Map()
    for (let i = 0; i < keys.length; i++) {
      const rec = this.#dht.get(keys[i])
      if (rec === undefined || rec === null) continue
      if (typeof rec !== 'object') { this.stats.shardMalformed++; continue }
      if (typeof rec.sig !== 'string') { this.stats.shardUnsigned++; continue }
      const { data, checksum, seq } = rec
      if (rec.i !== i || typeof data !== 'string' || !Number.isSafeInteger(checksum) || !Number.isSafeInteger(seq)) { this.stats.shardBadSignature++; continue }
      const bytes = new TextEncoder().encode(this.#text({ key: keys[i], i, seq, checksum, data }))
      let ok = false
      for (const raw of signers) {
        try {
          const key = await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
          if (await crypto.subtle.verify('Ed25519', key, Buffer.from(rec.sig, 'base64url'), bytes)) { ok = true; break }
        } catch { /* next */ }
      }
      if (!ok) { this.stats.shardBadSignature++; continue }
      if (!bySeq.has(seq)) bySeq.set(seq, new Map())
      bySeq.get(seq).set(i, data)
    }
    for (const seq of [...bySeq.keys()].sort((a, b) => b - a)) {
      const have = bySeq.get(seq)
      if (have.size < this.#k) continue
      for (const other of bySeq.keys()) if (other !== seq) this.stats.shardStale += bySeq.get(other).size
      const missing = []
      for (let i = 0; i < this.#k; i++) if (!have.has(i)) missing.push(i)
      if (missing.length > 1) throw new Error('unavailable: parity recovers one data shard')
      let parity = null
      for (let i = this.#k; i < this.#n; i++) if (have.has(i)) { parity = have.get(i); break }
      if (missing.length === 1) {
        if (parity === null) throw new Error('unavailable: no parity')
        let r = ''
        for (let c = 0; c < parity.length; c++) { let x = parity.charCodeAt(c); for (let i = 0; i < this.#k; i++) if (have.has(i)) x ^= have.get(i).charCodeAt(c); r += String.fromCharCode(x) }
        have.set(missing[0], r)
      }
      let out = ''
      for (let i = 0; i < this.#k; i++) out += have.get(i)
      return out.replace(/\0+$/, '')
    }
    throw new Error('unavailable: too few valid shards')
  }
}
