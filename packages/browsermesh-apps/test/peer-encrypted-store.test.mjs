/**
 * Tests for EncryptedBlobStore — encrypted blob storage over peer sessions.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/peer-encrypted-store.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Provide crypto.randomUUID if not available
if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

import {
  EncryptedBlobStore,
  ManifestEntry,
  encryptBlob,
  decryptBlob,
  computeCid,
} from '../src/peer-encrypted-store.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createFileShareService, FILE_CAPABILITIES } from '../src/peer-files.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

// ---------------------------------------------------------------------------
// Mock FileClient
// ---------------------------------------------------------------------------

// Matches the REAL FileClient's method signatures (peer-files.mjs):
// every operation takes pubKey FIRST (writeFile(pubKey, path, data), etc.)
// -- EncryptedBlobStore's own internal calls used to omit it entirely
// (calling writeFile(path, data) etc.), silently shifting every argument
// by one position. Undetected because this mock used to match the buggy
// 2-arg calls instead of the real 3-arg API. `_calls` records the pubKey
// each method was actually invoked with, so tests can assert it's really
// threaded through.
function createMockFileClient() {
  const files = new Map()
  const calls = []
  return {
    async writeFile(pubKey, path, data) {
      calls.push({ method: 'writeFile', pubKey, path })
      const size = data instanceof Uint8Array ? data.length : data.length
      files.set(path, { data, size })
      return { success: true, size }
    },
    async readFile(pubKey, path) {
      calls.push({ method: 'readFile', pubKey, path })
      const f = files.get(path)
      if (!f) throw new Error(`Not found: ${path}`)
      return { data: f.data, size: f.size }
    },
    async deleteFile(pubKey, path) {
      calls.push({ method: 'deleteFile', pubKey, path })
      return { success: files.delete(path) }
    },
    _calls: calls,
    _files: files,
  }
}

// ---------------------------------------------------------------------------
// Tests — encryptBlob
// ---------------------------------------------------------------------------

describe('encryptBlob', () => {
  it('produces different output than input', async () => {
    const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const { ciphertext, key, iv } = await encryptBlob(input)

    assert.ok(ciphertext instanceof Uint8Array)
    assert.ok(key instanceof Uint8Array)
    assert.ok(iv instanceof Uint8Array)
    assert.equal(key.length, 32)
    assert.equal(iv.length, 12)

    // Ciphertext should differ from input (includes auth tag so at least 16 bytes longer)
    assert.ok(ciphertext.length > input.length)
    const inputStr = input.join(',')
    const ctStr = ciphertext.slice(0, input.length).join(',')
    assert.notEqual(inputStr, ctStr)
  })
})

// ---------------------------------------------------------------------------
// Tests — decryptBlob
// ---------------------------------------------------------------------------

describe('decryptBlob', () => {
  it('recovers original data', async () => {
    const input = new TextEncoder().encode('hello encrypted world')
    const { ciphertext, key, iv } = await encryptBlob(input)
    const plaintext = await decryptBlob(ciphertext, key, iv)

    assert.deepEqual(plaintext, input)
  })

  it('fails with wrong key', async () => {
    const input = new Uint8Array([10, 20, 30, 40])
    const { ciphertext, iv } = await encryptBlob(input)

    // Generate a different random key
    const wrongKey = new Uint8Array(32)
    for (let i = 0; i < 32; i++) wrongKey[i] = i

    await assert.rejects(
      () => decryptBlob(ciphertext, wrongKey, iv),
      (err) => err.message.includes('ecrypt') || err.message.includes('authentication') || err.code === 'ERR_OSSL_BAD_DECRYPT',
    )
  })

  it('fails with wrong IV', async () => {
    const input = new Uint8Array([50, 60, 70, 80])
    const { ciphertext, key } = await encryptBlob(input)

    const wrongIv = new Uint8Array(12)
    for (let i = 0; i < 12; i++) wrongIv[i] = i

    await assert.rejects(
      () => decryptBlob(ciphertext, key, wrongIv),
      (err) => err.message.includes('ecrypt') || err.message.includes('authentication') || err.code === 'ERR_OSSL_BAD_DECRYPT',
    )
  })
})

// ---------------------------------------------------------------------------
// Tests — computeCid
// ---------------------------------------------------------------------------

describe('computeCid', () => {
  it('produces consistent hex hash', async () => {
    const data = new TextEncoder().encode('test data for hashing')
    const cid1 = await computeCid(data)
    const cid2 = await computeCid(data)

    assert.equal(typeof cid1, 'string')
    assert.equal(cid1.length, 64) // SHA-256 = 64 hex chars
    assert.equal(cid1, cid2)

    // Different data should produce a different CID
    const other = new TextEncoder().encode('different data')
    const cid3 = await computeCid(other)
    assert.notEqual(cid1, cid3)
  })
})

// ---------------------------------------------------------------------------
// Tests — EncryptedBlobStore.store
// ---------------------------------------------------------------------------

describe('EncryptedBlobStore', () => {
  let fileClient, store, logs

  beforeEach(() => {
    fileClient = createMockFileClient()
    logs = []
    store = new EncryptedBlobStore({
      fileClient,
      onLog: (level, msg) => logs.push({ level, msg }),
    })
  })

  it('constructor throws when fileClient is missing', () => {
    assert.throws(() => new EncryptedBlobStore({}), /fileClient is required/)
  })

  describe('store', () => {
    it('encrypts and uploads via fileClient', async () => {
      const data = new TextEncoder().encode('secret payload')
      const result = await store.store('peer-A', data)

      assert.ok(result.cid)
      assert.equal(typeof result.cid, 'string')
      assert.equal(result.cid.length, 64)
      assert.ok(result.key)
      assert.ok(result.iv)
      assert.equal(result.size, data.length)

      // fileClient should have the ciphertext stored
      const storedPath = `.encrypted-blobs/${result.cid}`
      assert.ok(fileClient._files.has(storedPath))

      // Stored data should be ciphertext (different from plaintext)
      const storedData = fileClient._files.get(storedPath).data
      assert.ok(storedData instanceof Uint8Array)
      assert.notDeepEqual(storedData, data)

      // Manifest should have one entry
      const manifest = store.listManifest()
      assert.equal(manifest.length, 1)
      assert.equal(manifest[0].cid, result.cid)
      assert.equal(manifest[0].peerId, 'peer-A')

      // Regression: fileClient.writeFile() must be called with peerId as
      // the leading argument (the real FileClient's signature) -- this
      // used to be silently omitted entirely.
      assert.equal(fileClient._calls.length, 1)
      assert.equal(fileClient._calls[0].method, 'writeFile')
      assert.equal(fileClient._calls[0].pubKey, 'peer-A')
    })
  })

  describe('retrieve', () => {
    it('downloads and decrypts', async () => {
      const plaintext = new TextEncoder().encode('retrieve me')
      const { cid, key, iv } = await store.store('peer-B', plaintext)

      const recovered = await store.retrieve('peer-B', cid, key, iv)
      assert.deepEqual(recovered, plaintext)

      // Regression: readFile() must receive peerId, not just path.
      const readCall = fileClient._calls.find(c => c.method === 'readFile')
      assert.equal(readCall.pubKey, 'peer-B')
    })
  })

  describe('delete', () => {
    it('removes from peer and manifest', async () => {
      const data = new TextEncoder().encode('delete me')
      const { cid } = await store.store('peer-C', data)

      assert.equal(store.listManifest().length, 1)
      assert.ok(fileClient._files.size > 0)

      const deleted = await store.delete('peer-C', cid)
      assert.equal(deleted, true)
      assert.equal(store.listManifest().length, 0)

      // Regression: deleteFile() must receive peerId, not just path.
      const deleteCall = fileClient._calls.find(c => c.method === 'deleteFile')
      assert.equal(deleteCall.pubKey, 'peer-C')
    })
  })

  describe('listManifest', () => {
    it('returns stored entries', async () => {
      await store.store('peer-D', new TextEncoder().encode('blob 1'))
      await store.store('peer-D', new TextEncoder().encode('blob 2'))

      const entries = store.listManifest()
      assert.equal(entries.length, 2)
      assert.ok(entries.every(e => e instanceof ManifestEntry))
      assert.ok(entries.every(e => e.peerId === 'peer-D'))
    })
  })

  describe('verify', () => {
    it('confirms CID integrity', async () => {
      const data = new TextEncoder().encode('verify me')
      const { cid } = await store.store('peer-E', data)

      const result = await store.verify('peer-E', cid)
      assert.equal(result.valid, true)
      assert.ok(result.size > 0)

      // Regression: verify()'s internal readFile() must receive peerId too.
      const readCalls = fileClient._calls.filter(c => c.method === 'readFile')
      assert.ok(readCalls.every(c => c.pubKey === 'peer-E'))
    })
  })

  describe('toJSON / fromJSON', () => {
    it('round-trips the manifest', async () => {
      await store.store('peer-F', new TextEncoder().encode('persist this'))
      await store.store('peer-G', new TextEncoder().encode('and this'))

      const json = store.toJSON()
      assert.equal(json.manifest.length, 2)

      const restored = EncryptedBlobStore.fromJSON(json, {
        fileClient,
        onLog: () => {},
      })

      const entries = restored.listManifest()
      assert.equal(entries.length, 2)
      assert.equal(entries[0].peerId, 'peer-F')
      assert.equal(entries[1].peerId, 'peer-G')
    })
  })

  describe('multiple peers tracked separately', () => {
    it('tracks blobs across different peers', async () => {
      const { cid: cid1 } = await store.store('peer-X', new TextEncoder().encode('data for X'))
      const { cid: cid2 } = await store.store('peer-Y', new TextEncoder().encode('data for Y'))
      const { cid: cid3 } = await store.store('peer-X', new TextEncoder().encode('more data for X'))

      const entries = store.listManifest()
      assert.equal(entries.length, 3)

      const peerXEntries = entries.filter(e => e.peerId === 'peer-X')
      const peerYEntries = entries.filter(e => e.peerId === 'peer-Y')

      assert.equal(peerXEntries.length, 2)
      assert.equal(peerYEntries.length, 1)

      // All CIDs should be unique
      const cids = new Set([cid1, cid2, cid3])
      assert.equal(cids.size, 3)
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — ManifestEntry serialization
// ---------------------------------------------------------------------------

describe('ManifestEntry', () => {
  it('round-trip serialization', () => {
    const entry = new ManifestEntry({
      cid: 'abc123',
      peerId: 'peer-Z',
      key: 'dGVzdGtleQ==',
      iv: 'dGVzdGl2',
      size: 42,
      metadata: { label: 'backup' },
      storedAt: 1700000000000,
    })

    const json = entry.toJSON()
    assert.equal(json.cid, 'abc123')
    assert.equal(json.peerId, 'peer-Z')
    assert.equal(json.key, 'dGVzdGtleQ==')
    assert.equal(json.iv, 'dGVzdGl2')
    assert.equal(json.size, 42)
    assert.deepEqual(json.metadata, { label: 'backup' })
    assert.equal(json.storedAt, 1700000000000)

    const restored = ManifestEntry.fromJSON(json)
    assert.equal(restored.cid, entry.cid)
    assert.equal(restored.peerId, entry.peerId)
    assert.equal(restored.key, entry.key)
    assert.equal(restored.iv, entry.iv)
    assert.equal(restored.size, entry.size)
    assert.deepEqual(restored.metadata, entry.metadata)
    assert.equal(restored.storedAt, entry.storedAt)
  })
})

// ---------------------------------------------------------------------------
// Real end-to-end: EncryptedBlobStore over the REAL FileHost/FileClient wire
// protocol between two real peers (not the mock above) -- the strongest
// possible regression guard for the peerId-argument bug: a mock can always
// be shaped to accidentally match a wrong call, but the real FileHost only
// answers if it's actually addressed correctly.
// ---------------------------------------------------------------------------

async function createRealPeer(label) {
  const identityManager = new MeshIdentityManager({})
  const wallet = new IdentityWallet({ identityManager })
  const { podId } = await wallet.createIdentity(label)
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  })
  return { podId, wallet, registry }
}

function wireRealNodes(peerA, peerB) {
  const listenersA = new Set()
  const listenersB = new Set()
  const nodeA = {
    podId: peerA.podId, wallet: peerA.wallet, registry: peerA.registry,
    onIncomingData(cb) { listenersA.add(cb); return () => listenersA.delete(cb) },
    async sendTo(pubKey, data) { queueMicrotask(() => { for (const cb of listenersB) cb(peerA.podId, data) }) },
  }
  const nodeB = {
    podId: peerB.podId, wallet: peerB.wallet, registry: peerB.registry,
    onIncomingData(cb) { listenersB.add(cb); return () => listenersB.delete(cb) },
    async sendTo(pubKey, data) { queueMicrotask(() => { for (const cb of listenersA) cb(peerB.podId, data) }) },
  }
  return { nodeA, nodeB }
}

function createRealMockFs() {
  const files = new Map()
  return {
    async list() { return [...files.entries()].map(([name, f]) => ({ name, type: 'file', size: f.size })) },
    async read(path) {
      const f = files.get(path)
      if (!f) throw new Error('Not found')
      return { data: f.data, size: f.size }
    },
    async write(path, data) {
      const size = data instanceof Uint8Array ? data.byteLength : data.length
      files.set(path, { data, size })
      return { success: true, size }
    },
    async delete(path) { return { success: files.delete(path) } },
    async stat(path) {
      const f = files.get(path)
      return f ? { name: path, type: 'file', size: f.size, modified: Date.now() } : null
    },
  }
}

describe('EncryptedBlobStore over a real FileHost/FileClient (two real peers)', () => {
  it('alice stores an encrypted blob on bob, then retrieves and decrypts it for real', async () => {
    const alice = await createRealPeer('alice')
    const bob = await createRealPeer('bob')
    const { nodeA, nodeB } = wireRealNodes(alice, bob)

    // bob hosts; alice needs read+write capability granted on bob's registry.
    bob.registry.grantCapabilities(alice.podId, [FILE_CAPABILITIES.READ, FILE_CAPABILITIES.WRITE, FILE_CAPABILITIES.DELETE])

    attachService(nodeB, undefined, createFileShareService({ fs: createRealMockFs() }))
    const { api } = attachService(nodeA, undefined, createFileShareService({}))

    const store = new EncryptedBlobStore({ fileClient: api })
    const plaintext = new TextEncoder().encode('genuinely over the wire')

    const { cid, key, iv } = await store.store(bob.podId, plaintext)
    const recovered = await store.retrieve(bob.podId, cid, key, iv)
    assert.deepEqual(recovered, plaintext)

    const verified = await store.verify(bob.podId, cid)
    assert.equal(verified.valid, true)

    const deleted = await store.delete(bob.podId, cid)
    assert.equal(deleted, true)
  })
})
