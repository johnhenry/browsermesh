/**
 * Unit tests for cloud-storage-backend.mjs (Phase B of the mesh-native-
 * services plan, issue/plan "CloudStorage: S3-like object storage").
 *
 * Local-only, single-peer this phase -- no mesh/PeerNode involved. Tests
 * drive the `Backend` through its real JSON-command-over-socket protocol
 * (`connect()` -> write JSON command -> read JSON response), the same way a
 * real client (or a future `CloudStorage` SDK class, Phase H) would.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/cloud-storage-backend.test.mjs
 */

import 'fake-indexeddb/auto'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { CloudStorageBackend } from '../src/cloud-storage-backend.mjs'
import { IndexedDBChunkStore } from '@johnhenry/browsermesh-sync'

// Use a fresh bucket name per test so tests don't interact through shared
// fake-indexeddb state (matches storage-indexeddb-chunks.test.mjs's own
// freshDbName() convention).
let bucketCounter = 0
function freshBucket() {
  bucketCounter += 1
  return `test-bucket-${bucketCounter}`
}

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

/** @param {string} str @returns {Uint8Array} */
function fromBase64(str) {
  return new Uint8Array(Buffer.from(str, 'base64'))
}

/**
 * Send one JSON command over a connected socket and read back the one JSON
 * response (the protocol is one write -> one read, exactly like
 * fs-service-backend.mjs's own request/response shape).
 * @param {import('@johnhenry/browsermesh-netway').StreamSocket} socket
 * @param {object} cmd
 * @returns {Promise<object>}
 */
async function send(socket, cmd) {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  await socket.write(encoder.encode(JSON.stringify(cmd)))
  const chunk = await socket.read()
  assert.ok(chunk !== null, 'socket closed before a response arrived')
  return JSON.parse(decoder.decode(chunk))
}

describe('CloudStorageBackend', () => {
  it('constructor requires a bucket name', () => {
    assert.throws(() => new CloudStorageBackend({}), /bucket is required/)
  })

  it('put then get round-trips a small object', async () => {
    const backend = new CloudStorageBackend({ bucket: freshBucket() })
    const socket = await backend.connect()

    const plaintext = new TextEncoder().encode('hello cloud storage')
    const putRes = await send(socket, {
      op: 'put',
      key: 'greeting.txt',
      data: toBase64(plaintext),
      contentType: 'text/plain',
      metadata: { author: 'test' },
    })
    assert.equal(putRes.stored, true)
    assert.equal(putRes.size, plaintext.length)

    const getRes = await send(socket, { op: 'get', key: 'greeting.txt' })
    assert.equal(getRes.size, plaintext.length)
    assert.equal(getRes.contentType, 'text/plain')
    assert.deepEqual(getRes.metadata, { author: 'test' })
    assert.deepEqual(fromBase64(getRes.data), plaintext)
  })

  it('put then get round-trips a multi-chunk object (>256KB)', async () => {
    const backend = new CloudStorageBackend({ bucket: freshBucket() })
    const socket = await backend.connect()

    // 256KB chunk size -> 700KB spans 3 chunks.
    const size = 700 * 1024
    const plaintext = new Uint8Array(size)
    for (let i = 0; i < size; i++) plaintext[i] = i % 256

    await send(socket, { op: 'put', key: 'big.bin', data: toBase64(plaintext) })
    const getRes = await send(socket, { op: 'get', key: 'big.bin' })

    assert.equal(getRes.size, size)
    assert.deepEqual(fromBase64(getRes.data), plaintext)
  })

  it('put of an empty object round-trips to zero bytes', async () => {
    const backend = new CloudStorageBackend({ bucket: freshBucket() })
    const socket = await backend.connect()

    await send(socket, { op: 'put', key: 'empty.bin', data: toBase64(new Uint8Array(0)) })
    const getRes = await send(socket, { op: 'get', key: 'empty.bin' })

    assert.equal(getRes.size, 0)
    assert.equal(fromBase64(getRes.data).length, 0)
  })

  it('get on a missing key returns {error: "not found"} without closing the socket', async () => {
    const backend = new CloudStorageBackend({ bucket: freshBucket() })
    const socket = await backend.connect()

    const res = await send(socket, { op: 'get', key: 'nope' })
    assert.equal(res.error, 'not found')

    // Socket still usable after the error.
    await send(socket, { op: 'put', key: 'a', data: toBase64(new Uint8Array([1])) })
    const res2 = await send(socket, { op: 'get', key: 'a' })
    assert.equal(res2.size, 1)
  })

  it('list with no prefix returns all keys; with a prefix filters', async () => {
    const backend = new CloudStorageBackend({ bucket: freshBucket() })
    const socket = await backend.connect()

    await send(socket, { op: 'put', key: 'docs/a.txt', data: toBase64(new Uint8Array([1])) })
    await send(socket, { op: 'put', key: 'docs/b.txt', data: toBase64(new Uint8Array([2, 2])) })
    await send(socket, { op: 'put', key: 'images/c.png', data: toBase64(new Uint8Array([3, 3, 3])) })

    const all = await send(socket, { op: 'list' })
    assert.equal(all.keys.length, 3)
    const keys = all.keys.map((k) => k.key).sort()
    assert.deepEqual(keys, ['docs/a.txt', 'docs/b.txt', 'images/c.png'])
    for (const entry of all.keys) {
      assert.equal(typeof entry.size, 'number')
      assert.equal(typeof entry.updatedAt, 'number')
    }

    const filtered = await send(socket, { op: 'list', prefix: 'docs/' })
    assert.equal(filtered.keys.length, 2)
    assert.deepEqual(filtered.keys.map((k) => k.key).sort(), ['docs/a.txt', 'docs/b.txt'])
  })

  it('delete tombstones a key; subsequent get returns not found', async () => {
    const backend = new CloudStorageBackend({ bucket: freshBucket() })
    const socket = await backend.connect()

    await send(socket, { op: 'put', key: 'temp.txt', data: toBase64(new Uint8Array([9])) })
    const delRes = await send(socket, { op: 'delete', key: 'temp.txt' })
    assert.equal(delRes.deleted, true)

    const getRes = await send(socket, { op: 'get', key: 'temp.txt' })
    assert.equal(getRes.error, 'not found')

    const listRes = await send(socket, { op: 'list' })
    assert.equal(listRes.keys.length, 0)
  })

  it('head returns metadata without the data payload', async () => {
    const backend = new CloudStorageBackend({ bucket: freshBucket() })
    const socket = await backend.connect()

    const plaintext = new TextEncoder().encode('some content')
    await send(socket, {
      op: 'put',
      key: 'k',
      data: toBase64(plaintext),
      contentType: 'application/json',
      metadata: { x: 1 },
    })

    const headRes = await send(socket, { op: 'head', key: 'k' })
    assert.equal(headRes.size, plaintext.length)
    assert.equal(headRes.contentType, 'application/json')
    assert.deepEqual(headRes.metadata, { x: 1 })
    assert.equal(typeof headRes.updatedAt, 'number')
    assert.equal(headRes.version, 1)
    assert.equal('data' in headRes, false)
  })

  it('head on a missing key returns {error: "not found"}', async () => {
    const backend = new CloudStorageBackend({ bucket: freshBucket() })
    const socket = await backend.connect()

    const res = await send(socket, { op: 'head', key: 'nope' })
    assert.equal(res.error, 'not found')
  })

  it('re-putting the same key increments version', async () => {
    const backend = new CloudStorageBackend({ bucket: freshBucket() })
    const socket = await backend.connect()

    await send(socket, { op: 'put', key: 'k', data: toBase64(new Uint8Array([1])) })
    await send(socket, { op: 'put', key: 'k', data: toBase64(new Uint8Array([1, 2])) })
    const headRes = await send(socket, { op: 'head', key: 'k' })
    assert.equal(headRes.version, 2)
    assert.equal(headRes.size, 2)
  })

  it('unknown op returns an error without closing the socket', async () => {
    const backend = new CloudStorageBackend({ bucket: freshBucket() })
    const socket = await backend.connect()

    const res = await send(socket, { op: 'frobnicate' })
    assert.match(res.error, /Unknown op/)

    const res2 = await send(socket, { op: 'list' })
    assert.deepEqual(res2.keys, [])
  })

  // -------------------------------------------------------------------
  // Encryption-at-rest: the actual point of this phase.
  // -------------------------------------------------------------------

  it('stores ciphertext, not plaintext, in the underlying chunk store', async () => {
    const bucket = freshBucket()
    const chunkStore = new IndexedDBChunkStore({ dbName: `${bucket}-chunks-direct` })
    const backend = new CloudStorageBackend({ bucket, dbName: bucket, chunkStore })
    const socket = await backend.connect()

    const plaintext = new TextEncoder().encode('this is definitely secret plaintext')
    await send(socket, { op: 'put', key: 'secret.txt', data: toBase64(plaintext) })

    const headRes = await send(socket, { op: 'head', key: 'secret.txt' })
    assert.equal(headRes.size, plaintext.length)

    // Read the manifest directly to find the chunk CID(s), then read the raw
    // bytes back from the chunk store the backend itself used, bypassing
    // the backend's own decrypt path entirely.
    const { IndexedDBSyncStorage } = await import('@johnhenry/browsermesh-sync')
    const manifestStorage = new IndexedDBSyncStorage({ dbName: `${bucket}-manifest` })
    const docs = await manifestStorage.load()
    const manifestDoc = docs.find((d) => d.id === 'manifest')
    const entry = manifestDoc.entries['secret.txt']
    assert.ok(entry && !entry.tombstone, 'expected a live manifest entry for secret.txt')
    assert.equal(entry.value.chunks.length, 1)

    const cid = entry.value.chunks[0].cid
    const rawBytes = await chunkStore.get(cid)
    assert.ok(rawBytes, 'expected the chunk to actually be present in the chunk store')

    // The raw stored bytes must NOT equal the plaintext -- this is the
    // assertion that actually proves encryption happened, not just that
    // round-tripping through the backend's own decrypt path works.
    assert.notDeepEqual(rawBytes, plaintext)
    // Ciphertext-with-appended-16-byte-GCM-tag is always longer than the
    // plaintext it came from.
    assert.ok(rawBytes.length > plaintext.length)
  })

  it('two different puts of identical plaintext produce different ciphertext (fresh IV per chunk)', async () => {
    const bucket = freshBucket()
    const backend = new CloudStorageBackend({ bucket })
    const socket = await backend.connect()

    const plaintext = new TextEncoder().encode('identical content')
    await send(socket, { op: 'put', key: 'a', data: toBase64(plaintext) })
    await send(socket, { op: 'put', key: 'b', data: toBase64(plaintext) })

    const { IndexedDBSyncStorage } = await import('@johnhenry/browsermesh-sync')
    const manifestStorage = new IndexedDBSyncStorage({ dbName: `cloud-storage-${bucket}-manifest` })
    const docs = await manifestStorage.load()
    const manifestDoc = docs.find((d) => d.id === 'manifest')
    const cidA = manifestDoc.entries['a'].value.chunks[0].cid
    const cidB = manifestDoc.entries['b'].value.chunks[0].cid

    // Different IVs -> different ciphertext -> different CIDs, even though
    // the plaintext (and the bucket key) are identical.
    assert.notEqual(cidA, cidB)
  })

  // -------------------------------------------------------------------
  // Durability across "reload" -- the actual point of this phase's name.
  // -------------------------------------------------------------------

  it('survives a reload: a fresh instance over the same storage returns identical decrypted bytes', async () => {
    const bucket = freshBucket()

    // "Session 1": write via one backend instance.
    const backend1 = new CloudStorageBackend({ bucket })
    const socket1 = await backend1.connect()
    const plaintext = new TextEncoder().encode('durable across reload')
    await send(socket1, {
      op: 'put',
      key: 'k',
      data: toBase64(plaintext),
      contentType: 'text/plain',
      metadata: { note: 'persisted' },
    })
    await backend1.close()

    // "Session 2" (simulated reload): a brand new CloudStorageBackend
    // instance, constructed with nothing but the same `bucket` name. Because
    // the bucket key, the manifest, and the chunks are each persisted to
    // real (fake-indexeddb-backed) IndexedDB databases derived
    // deterministically from `bucket`, the fresh instance finds and reuses
    // the SAME already-persisted bucket key on its first op (see
    // `#loadOrCreateKey`) rather than generating a new one -- this is how
    // the bucket key persists across a reload in this single-peer phase.
    // (Cross-*peer* key distribution is Phase E's job, not this one's.)
    const backend2 = new CloudStorageBackend({ bucket })
    const socket2 = await backend2.connect()
    const getRes = await send(socket2, { op: 'get', key: 'k' })

    assert.equal(getRes.error, undefined)
    assert.equal(getRes.contentType, 'text/plain')
    assert.deepEqual(getRes.metadata, { note: 'persisted' })
    assert.deepEqual(fromBase64(getRes.data), plaintext)
  })

  it('a fresh instance pointed at a DIFFERENT bucket name cannot read the first bucket\'s data', async () => {
    const bucket = freshBucket()
    const backend1 = new CloudStorageBackend({ bucket })
    const socket1 = await backend1.connect()
    await send(socket1, { op: 'put', key: 'k', data: toBase64(new TextEncoder().encode('secret')) })
    await backend1.close()

    const backend2 = new CloudStorageBackend({ bucket: freshBucket() })
    const socket2 = await backend2.connect()
    const getRes = await send(socket2, { op: 'get', key: 'k' })
    assert.equal(getRes.error, 'not found')
  })
})
