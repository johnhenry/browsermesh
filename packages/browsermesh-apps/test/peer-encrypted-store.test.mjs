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

// ---------------------------------------------------------------------------
// Mock FileClient
// ---------------------------------------------------------------------------

function createMockFileClient() {
  const files = new Map()
  return {
    async writeFile(path, data) {
      const size = data instanceof Uint8Array ? data.length : data.length
      files.set(path, { data, size })
      return { success: true, size }
    },
    async readFile(path) {
      const f = files.get(path)
      if (!f) throw new Error(`Not found: ${path}`)
      return { data: f.data, size: f.size }
    },
    async deleteFile(path) {
      return { success: files.delete(path) }
    },
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
    })
  })

  describe('retrieve', () => {
    it('downloads and decrypts', async () => {
      const plaintext = new TextEncoder().encode('retrieve me')
      const { cid, key, iv } = await store.store('peer-B', plaintext)

      const recovered = await store.retrieve('peer-B', cid, key, iv)
      assert.deepEqual(recovered, plaintext)
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
