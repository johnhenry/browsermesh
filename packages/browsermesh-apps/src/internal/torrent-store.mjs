// Shared helpers for TorrentManager (peer-torrent.mjs) and
// createTorrentService (mesh-torrent.mjs): byte-input normalisation, the
// default in-memory manifest store, and reference-counted chunk release.
//
// No browser-only imports at module level.

/**
 * Normalise anything `seed()` accepts to a `Uint8Array`.
 *
 *   string                 -> UTF-8 bytes
 *   Blob                   -> its bytes
 *   ArrayBuffer            -> a view over it
 *   TypedArray / DataView  -> a Uint8Array over the same bytes (Uint8Array is returned as-is)
 *
 * Anything else throws a `TypeError`. It must not fall through to
 * `new Uint8Array(x)`: for a string or a plain object that yields an EMPTY
 * array, which silently seeded zero bytes (#195).
 *
 * @param {unknown} data
 * @returns {Promise<Uint8Array>}
 */
export async function toSeedBytes(data) {
  if (data instanceof Uint8Array) return data
  if (typeof data === 'string') return new TextEncoder().encode(data)
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer) return new Uint8Array(data)
  const got = data === null ? 'null' : Array.isArray(data) ? 'Array' : typeof data === 'object' ? (data.constructor?.name || 'object') : typeof data
  throw new TypeError(
    `seed(): data must be a string, Uint8Array, other TypedArray, ArrayBuffer or Blob (got ${got})`,
  )
}

/**
 * Default `manifestStore`: a `Map` behind the async-tolerant contract
 *
 *   get(key) -> manifest | undefined | null
 *   set(key, manifest) -> void
 *   delete(key) -> void
 *   entries() -> Iterable<[key, manifest]> | Array<[key, manifest]>
 *
 * (every method may be sync or return a Promise). Keys are magnet URIs;
 * values are JSON-safe `{ infoHash, name, size, chunkSize, chunkCids, cid }`
 * records, so a durable implementation can simply JSON-serialise them.
 */
export class MemoryManifestStore {
  #m = new Map()
  get(key) { return this.#m.get(key) }
  set(key, manifest) { this.#m.set(key, manifest) }
  delete(key) { this.#m.delete(key) }
  entries() { return [...this.#m.entries()] }
  clear() { this.#m.clear() }
  get size() { return this.#m.size }
}

/**
 * Remove the chunks of `manifest` from `chunkStore`, except any that another
 * manifest in `manifestStore` (other than `exceptKey`) still lists -- chunks
 * are content-addressed and shared between torrents that contain identical
 * pieces.
 *
 * @param {object} chunkStore
 * @param {object} manifestStore
 * @param {{ chunkCids: string[] }} manifest
 * @param {string} exceptKey magnet URI being removed
 * @returns {Promise<number>} chunks removed
 */
export async function releaseChunks(chunkStore, manifestStore, manifest, exceptKey) {
  const stillUsed = new Set()
  for (const [key, other] of await manifestStore.entries()) {
    if (key === exceptKey || !other || !Array.isArray(other.chunkCids)) continue
    for (const cid of other.chunkCids) stillUsed.add(cid)
  }
  let removed = 0
  for (const cid of new Set(manifest.chunkCids)) {
    if (stillUsed.has(cid)) continue
    if (await chunkStore.remove(cid)) removed++
  }
  return removed
}

/**
 * Split `bytes` into `chunkSize` pieces (zero pieces for empty input).
 * @param {Uint8Array} bytes
 * @param {number} chunkSize
 * @returns {Uint8Array[]}
 */
export function splitIntoChunks(bytes, chunkSize) {
  const pieces = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    pieces.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  }
  return pieces
}

/**
 * @param {object} store a ChunkStore-contract object (sync or async)
 * @param {Uint8Array[]} pieces
 * @param {(piece: Uint8Array) => Promise<string>} computeCid
 * @returns {Promise<string[]>} the pieces' CIDs, in order. Pieces already in the store are not re-written.
 */
export async function saveChunks(store, pieces, computeCid) {
  const cids = []
  for (const piece of pieces) {
    const cid = await computeCid(piece)
    if (!(await store.has(cid))) await store.save(cid, piece)
    cids.push(cid)
  }
  return cids
}

/**
 * Token bucket: `rate` bytes/second with a one-second burst. `take(n)` waits
 * until `n` bytes of budget exist (a single piece larger than one second's
 * budget waits for a full bucket, never forever). `rate <= 0` or `Infinity`
 * disables the limit.
 *
 * @param {object} opts
 * @param {number} opts.rate
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 */
export function createByteBucket({ rate, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const unlimited = !(rate > 0) || !Number.isFinite(rate)
  let tokens = rate
  let last = now()
  return {
    async take(bytes) {
      if (unlimited) return
      const need = Math.min(bytes, rate)
      for (;;) {
        const t = now()
        tokens = Math.min(rate, tokens + ((t - last) / 1000) * rate)
        last = t
        if (tokens >= need) { tokens -= need; return }
        await sleep(Math.ceil(((need - tokens) / rate) * 1000))
      }
    },
  }
}
