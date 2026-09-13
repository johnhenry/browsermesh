/**
 * Tests for peer-files.mjs -- FileHost, FileClient, and createFileShareService
 * (the MeshService wrapper).
 *
 * Matches this family's established pattern for this kind of test
 * (mesh-rpc.test.mjs / chunk-replication.test.mjs / manifest-sync.test.mjs
 * are the direct precedents): real `PeerRegistry`s wired to real `MeshACL`
 * (`@johnhenry/browsermesh-core`), real Ed25519 `IdentityWallet`/
 * `MeshIdentityManager` identities, connected via a minimal duck-typed
 * in-memory bus (not real WebRTC -- that's a later phase's job).
 *
 * `FileHost#handleRequest()` (pure compute, no transport) is also tested
 * directly, independent of the mesh transport layer, for the file-operation
 * logic itself (list/read/write/delete/stat correctness, size limits, error
 * cases) -- porting forward the meaningful coverage the old
 * `PeerSession`-based test file had, adapted to the new pure-function shape.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/peer-files.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import {
  FileHost,
  FileClient,
  createFileShareService,
  FILE_DEFAULTS,
  FILE_ACTIONS,
  FILE_CAPABILITIES,
  FILE_RESOURCE,
} from '../src/peer-files.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

// ---------------------------------------------------------------------------
// Test fixtures (mirrors mesh-rpc.test.mjs's own)
// ---------------------------------------------------------------------------

/** A real Ed25519 identity + wallet + registry bundle for one "peer". */
async function createPeer(label) {
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

/**
 * A minimal duck-typed `PeerNode` pair, matching mesh-rpc.test.mjs's own
 * `wireNodes()` exactly: `podId`/`wallet`/`registry` plus an async
 * `sendTo()`/`onIncomingData()` bus.
 */
function wireNodes(peerA, peerB) {
  const listenersA = new Set()
  const listenersB = new Set()

  const nodeA = {
    podId: peerA.podId,
    wallet: peerA.wallet,
    registry: peerA.registry,
    onIncomingData(cb) {
      listenersA.add(cb)
      return () => listenersA.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersB) cb(peerA.podId, data)
      })
    },
  }
  const nodeB = {
    podId: peerB.podId,
    wallet: peerB.wallet,
    registry: peerB.registry,
    onIncomingData(cb) {
      listenersB.add(cb)
      return () => listenersB.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersA) cb(peerB.podId, data)
      })
    },
  }
  return { nodeA, nodeB }
}

/**
 * A "black hole" node: sendTo() never delivers anything to anyone. Used for
 * the timeout test, where the host side must never respond.
 */
function wireBlackHole(peerA) {
  const listenersA = new Set()
  return {
    podId: peerA.podId,
    wallet: peerA.wallet,
    registry: peerA.registry,
    onIncomingData(cb) {
      listenersA.add(cb)
      return () => listenersA.delete(cb)
    },
    async sendTo() {
      // Never delivered -- the "peer" this points at doesn't exist.
    },
  }
}

/** In-memory fs fixture matching FileHost's duck-typed interface. */
function createMockFs() {
  const files = new Map([['test.txt', { data: 'hello', size: 5 }]])
  return {
    async list() {
      return [...files.entries()].map(([name, f]) => ({ name, type: 'file', size: f.size }))
    },
    async read(path) {
      const f = files.get(path)
      if (!f) throw new Error('Not found')
      return { data: f.data, size: f.size }
    },
    async write(path, data) {
      const size = typeof data === 'string' ? data.length : data.byteLength
      files.set(path, { data, size })
      return { success: true, size }
    },
    async delete(path) {
      return { success: files.delete(path) }
    },
    async stat(path) {
      const f = files.get(path)
      return f ? { name: path, type: 'file', size: f.size, modified: Date.now() } : null
    },
  }
}

// ---------------------------------------------------------------------------
// Tests — Constants
// ---------------------------------------------------------------------------

describe('FILE_DEFAULTS', () => {
  it('has correct values', () => {
    assert.equal(FILE_DEFAULTS.maxFileSize, 10 * 1024 * 1024)
    assert.equal(FILE_DEFAULTS.timeout, 30000)
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(FILE_DEFAULTS))
  })
})

describe('FILE_ACTIONS', () => {
  it('has correct values', () => {
    assert.equal(FILE_ACTIONS.LIST, 'list')
    assert.equal(FILE_ACTIONS.READ, 'read')
    assert.equal(FILE_ACTIONS.WRITE, 'write')
    assert.equal(FILE_ACTIONS.DELETE, 'delete')
    assert.equal(FILE_ACTIONS.STAT, 'stat')
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(FILE_ACTIONS))
  })
})

describe('FILE_CAPABILITIES', () => {
  it('aligns with browsermesh-core acl.mjs DEFAULT_TEMPLATES vocabulary', () => {
    assert.equal(FILE_CAPABILITIES.READ, 'files:read')
    assert.equal(FILE_CAPABILITIES.WRITE, 'files:write')
    assert.equal(FILE_CAPABILITIES.DELETE, 'files:delete')
    assert.equal(FILE_RESOURCE, 'files')
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(FILE_CAPABILITIES))
  })
})

// ---------------------------------------------------------------------------
// Tests — FileHost (direct, no transport -- pure request/response logic)
// ---------------------------------------------------------------------------

describe('FileHost#handleRequest (direct, no transport)', () => {
  let fs, host

  beforeEach(() => {
    fs = createMockFs()
    // No checkAccess supplied -- permissive default (see class doc comment).
    host = new FileHost({ fs })
  })

  it('throws when fs is missing', () => {
    assert.throws(() => new FileHost({}), /fs.*list/)
  })

  it('handles list action', async () => {
    const response = await host.handleRequest('peerA', { action: 'list', path: '/', requestId: 'req-list' })
    assert.equal(response.success, true)
    assert.equal(response.requestId, 'req-list')
    assert.ok(Array.isArray(response.result))
    assert.equal(response.result[0].name, 'test.txt')
  })

  it('handles read action', async () => {
    const response = await host.handleRequest('peerA', { action: 'read', path: 'test.txt', requestId: 'req-read' })
    assert.equal(response.success, true)
    assert.equal(response.result.data, 'hello')
    assert.equal(response.result.size, 5)
  })

  it('handles read action for a missing file as an error', async () => {
    const response = await host.handleRequest('peerA', { action: 'read', path: 'missing.txt', requestId: 'req-read2' })
    assert.equal(response.success, false)
    assert.equal(response.error, 'Not found')
  })

  it('handles write action', async () => {
    const response = await host.handleRequest('peerA', { action: 'write', path: 'new.txt', data: 'new content', requestId: 'req-write' })
    assert.equal(response.success, true)
    assert.equal(response.result.size, 11)
  })

  it('rejects write with null/undefined data', async () => {
    const response = await host.handleRequest('peerA', { action: 'write', path: 'new.txt', requestId: 'req-write-nodata' })
    assert.equal(response.success, false)
    assert.equal(response.error, 'Write data is required')
  })

  it('handles delete action', async () => {
    const response = await host.handleRequest('peerA', { action: 'delete', path: 'test.txt', requestId: 'req-del' })
    assert.equal(response.success, true)
    assert.equal(response.result.success, true)
  })

  it('handles stat action', async () => {
    const response = await host.handleRequest('peerA', { action: 'stat', path: 'test.txt', requestId: 'req-stat' })
    assert.equal(response.success, true)
    assert.equal(response.result.name, 'test.txt')
    assert.equal(response.result.type, 'file')
    assert.equal(response.result.size, 5)
  })

  it('returns null result for stat of a non-existent file (still success)', async () => {
    const response = await host.handleRequest('peerA', { action: 'stat', path: 'missing.txt', requestId: 'req-stat2' })
    assert.equal(response.success, true)
    assert.equal(response.result, null)
  })

  it('rejects an unknown action', async () => {
    const response = await host.handleRequest('peerA', { action: 'destroy', path: 'x', requestId: 'req-bad' })
    assert.equal(response.success, false)
    assert.match(response.error, /Unknown action/)
  })

  it('rejects a missing/empty path', async () => {
    const response = await host.handleRequest('peerA', { action: 'list', path: '', requestId: 'req-nopath' })
    assert.equal(response.success, false)
    assert.match(response.error, /path must be/)
  })

  it('rejects oversized writes', async () => {
    const smallHost = new FileHost({ fs, maxFileSize: 10 })
    const response = await smallHost.handleRequest('peerA', { action: 'write', path: 'big.txt', data: 'x'.repeat(100), requestId: 'req-big' })
    assert.equal(response.success, false)
    assert.match(response.error, /exceeds/)
  })

  describe('checkAccess gating', () => {
    it('rejects write when checkAccess denies', async () => {
      const gatedHost = new FileHost({
        fs,
        checkAccess: (fromPubKey, action) => ({ allowed: action === 'read', reason: 'no write grant' }),
      })
      const response = await gatedHost.handleRequest('peerA', { action: 'write', path: 'new.txt', data: 'x', requestId: 'req-noperm' })
      assert.equal(response.success, false)
      assert.match(response.error, /Capability/)
      assert.match(response.error, /no write grant/)
    })

    it('rejects delete when checkAccess denies', async () => {
      const gatedHost = new FileHost({
        fs,
        checkAccess: (fromPubKey, action) => ({ allowed: action === 'read' }),
      })
      const response = await gatedHost.handleRequest('peerA', { action: 'delete', path: 'test.txt', requestId: 'req-nodelperm' })
      assert.equal(response.success, false)
      assert.ok(response.error)
    })

    it('allows read when checkAccess allows', async () => {
      const gatedHost = new FileHost({
        fs,
        checkAccess: (fromPubKey, action) => ({ allowed: action === 'read' }),
      })
      const response = await gatedHost.handleRequest('peerA', { action: 'list', path: '/', requestId: 'req-ok' })
      assert.equal(response.success, true)
    })

    it('passes the requesting pubKey and capability action to checkAccess', async () => {
      const seen = []
      const gatedHost = new FileHost({
        fs,
        checkAccess: (fromPubKey, action) => {
          seen.push({ fromPubKey, action })
          return { allowed: true }
        },
      })
      await gatedHost.handleRequest('peer-xyz', { action: 'write', path: 'a.txt', data: 'x', requestId: 'r1' })
      assert.deepEqual(seen, [{ fromPubKey: 'peer-xyz', action: 'write' }])
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — createFileShareService, wired over a real mesh transport
// ---------------------------------------------------------------------------

describe('createFileShareService: mesh-wired FileHost/FileClient', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodeA
  /** @type {any} */ let nodeB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    ;({ nodeA, nodeB } = wireNodes(alice, bob))
  })

  it('a client (alice) can list/read/write/delete/stat files hosted by bob, once granted capabilities', async () => {
    // bob hosts, alice requests -- it's bob's registry that gates requests
    // arriving from alice.
    bob.registry.grantCapabilities(alice.podId, [FILE_CAPABILITIES.READ, FILE_CAPABILITIES.WRITE, FILE_CAPABILITIES.DELETE])

    const fs = createMockFs()
    attachService(nodeB, undefined, createFileShareService({ fs }))
    const { api } = attachService(nodeA, undefined, createFileShareService({}))

    const listed = await api.listFiles(bob.podId, '/')
    assert.ok(Array.isArray(listed))
    assert.equal(listed[0].name, 'test.txt')

    const read = await api.readFile(bob.podId, 'test.txt')
    assert.equal(read.data, 'hello')

    const written = await api.writeFile(bob.podId, 'new.txt', 'created by alice')
    assert.equal(written.success, true)

    const stat = await api.stat(bob.podId, 'new.txt')
    assert.equal(stat.name, 'new.txt')

    const deleted = await api.deleteFile(bob.podId, 'new.txt')
    assert.equal(deleted.success, true)
  })

  it('rejects a write from a peer with only read capability, via a real PeerRegistry/MeshACL check', async () => {
    bob.registry.grantCapabilities(alice.podId, [FILE_CAPABILITIES.READ])

    const fs = createMockFs()
    attachService(nodeB, undefined, createFileShareService({ fs }))
    const { api } = attachService(nodeA, undefined, createFileShareService({}))

    await assert.rejects(
      () => api.writeFile(bob.podId, 'new.txt', 'nope'),
      /Capability/,
    )
  })

  it('a peer hosting no fs (client-only) replies with a clean "not hosting" error instead of dropping the request', async () => {
    // nodeB attaches with no `fs` at all -- client-only.
    attachService(nodeB, undefined, createFileShareService({}))
    const { api } = attachService(nodeA, undefined, createFileShareService({}))

    await assert.rejects(
      () => api.listFiles(bob.podId, '/'),
      /not hosting files/,
    )
  })

  it('concurrent requests to the same peer do not cross-correlate', async () => {
    bob.registry.grantCapabilities(alice.podId, [FILE_CAPABILITIES.READ])
    const fs = createMockFs()
    await fs.write('a.txt', 'AAA')
    await fs.write('b.txt', 'BBBBB')

    attachService(nodeB, undefined, createFileShareService({ fs }))
    const { api } = attachService(nodeA, undefined, createFileShareService({}))

    const [a, b] = await Promise.all([
      api.readFile(bob.podId, 'a.txt'),
      api.readFile(bob.podId, 'b.txt'),
    ])
    assert.equal(a.data, 'AAA')
    assert.equal(b.data, 'BBBBB')
  })

  it('a response from a different peer than the one requested is ignored (not cross-correlated)', async () => {
    // Three-party setup: alice requests from bob, but a malicious/confused
    // carol sends a files-response claiming alice's requestId. It must be
    // ignored -- only bob's genuine reply resolves the promise (bob never
    // replies here, so the real result is a timeout).
    const carol = await createPeer('carol')
    const listenersA = new Set()
    const listenersB = new Set()
    const listenersC = new Set()

    const nA = {
      podId: alice.podId, wallet: alice.wallet, registry: alice.registry,
      onIncomingData(cb) { listenersA.add(cb); return () => listenersA.delete(cb) },
      async sendTo(pubKey, data) {
        const target = pubKey === bob.podId ? listenersB : listenersC
        queueMicrotask(() => { for (const cb of target) cb(alice.podId, data) })
      },
    }
    const nB = {
      podId: bob.podId, wallet: bob.wallet, registry: bob.registry,
      onIncomingData(cb) { listenersB.add(cb); return () => listenersB.delete(cb) },
      async sendTo() { /* bob deliberately never replies in this test */ },
    }

    bob.registry.grantCapabilities(alice.podId, [FILE_CAPABILITIES.READ])

    const { api: aliceApi } = attachService(nA, undefined, createFileShareService({ timeout: 150 }))
    attachService(nB, undefined, createFileShareService({})) // never responds

    const promise = aliceApi.readFile(bob.podId, 'test.txt')

    // Snoop the outbound request from alice to bob to steal its requestId,
    // then have carol forge a response using that id.
    let requestId
    listenersB.add((fromPubKey, msg) => { requestId = msg.requestId })
    await new Promise((r) => setTimeout(r, 10))
    assert.ok(requestId, 'expected to observe the outbound requestId')

    queueMicrotask(() => {
      for (const cb of listenersA) {
        cb(carol.podId, { type: 'files-response', requestId, action: 'read', success: true, result: { data: 'FORGED', size: 6 } })
      }
    })

    // The forged response must be ignored; the real timeout must still fire.
    await assert.rejects(() => promise, /timed out/)
  })
})

// ---------------------------------------------------------------------------
// Tests — timeout (host never responds)
// ---------------------------------------------------------------------------

describe('createFileShareService: timeout', () => {
  it('rejects when the target peer never responds', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = wireBlackHole(alice)

    const { api } = attachService(nodeA, undefined, createFileShareService({ timeout: 50 }))

    await assert.rejects(
      () => api.readFile(bob.podId, 'slow.txt'),
      /timed out/,
    )
  })
})

// ---------------------------------------------------------------------------
// Tests — teardown
// ---------------------------------------------------------------------------

describe('createFileShareService: teardown', () => {
  it('rejects pending requests on teardown', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    bob.registry.grantCapabilities(alice.podId, [FILE_CAPABILITIES.READ])
    const fs = createMockFs()
    attachService(nodeB, undefined, createFileShareService({ fs }))
    const { api, teardown } = attachService(nodeA, undefined, createFileShareService({ timeout: 200 }))

    const pending = api.readFile(bob.podId, 'test.txt')
    await teardown()
    await assert.rejects(() => pending, /closed/)
  })
})

// ---------------------------------------------------------------------------
// Tests — FileClient direct unit tests (sendRequest injected directly,
// no mesh-service layer -- for the correlation/timeout mechanism itself)
// ---------------------------------------------------------------------------

describe('FileClient (direct, injected sendRequest)', () => {
  it('throws when sendRequest is missing', () => {
    assert.throws(() => new FileClient({}), /sendRequest/)
  })

  it('resolves listFiles when a matching response arrives from the right peer', async () => {
    let capturedRequestId
    const client = new FileClient({
      sendRequest: (pubKey, payload) => { capturedRequestId = payload.requestId },
    })
    const promise = client.listFiles('peerB', '/docs')
    await new Promise((r) => setTimeout(r, 0))
    client.handleResponse('peerB', { requestId: capturedRequestId, action: 'list', success: true, result: [{ name: 'a.txt' }] })
    const result = await promise
    assert.deepEqual(result, [{ name: 'a.txt' }])
  })

  it('rejects on remote error', async () => {
    let capturedRequestId
    const client = new FileClient({
      sendRequest: (pubKey, payload) => { capturedRequestId = payload.requestId },
    })
    const promise = client.readFile('peerB', 'bad.txt')
    await new Promise((r) => setTimeout(r, 0))
    client.handleResponse('peerB', { requestId: capturedRequestId, action: 'read', success: false, error: 'Not found' })
    await assert.rejects(() => promise, /Not found/)
  })

  it('rejects on timeout when no response ever arrives', async () => {
    const client = new FileClient({ sendRequest: () => {}, timeout: 30 })
    await assert.rejects(() => client.readFile('peerB', 'slow.txt'), /timed out/)
  })

  it('two concurrent requests to different peers resolve independently', async () => {
    const sent = []
    const client = new FileClient({
      sendRequest: (pubKey, payload) => { sent.push({ pubKey, payload }) },
    })
    const p1 = client.readFile('peerB', 'x.txt')
    const p2 = client.readFile('peerC', 'y.txt')
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(sent.length, 2)

    client.handleResponse('peerC', { requestId: sent[1].payload.requestId, action: 'read', success: true, result: { data: 'Y' } })
    client.handleResponse('peerB', { requestId: sent[0].payload.requestId, action: 'read', success: true, result: { data: 'X' } })

    const [r1, r2] = await Promise.all([p1, p2])
    assert.equal(r1.data, 'X')
    assert.equal(r2.data, 'Y')
  })

  it('ignores a response whose requestId matches but the sender does not', async () => {
    const sent = []
    const client = new FileClient({
      sendRequest: (pubKey, payload) => { sent.push({ pubKey, payload }) },
      timeout: 40,
    })
    const promise = client.readFile('peerB', 'x.txt')
    await new Promise((r) => setTimeout(r, 0))
    // Wrong sender -- ignored.
    client.handleResponse('peerC', { requestId: sent[0].payload.requestId, action: 'read', success: true, result: { data: 'WRONG' } })
    await assert.rejects(() => promise, /timed out/)
  })

  it('close() rejects all pending requests', async () => {
    const client = new FileClient({ sendRequest: () => {} })
    const promise = client.listFiles('peerB', '/foo')
    client.close()
    await assert.rejects(() => promise, /FileClient closed/)
  })

  it('validates pubKey and path', async () => {
    const client = new FileClient({ sendRequest: () => {} })
    await assert.rejects(() => client.readFile('', 'x.txt'), /pubKey/)
    await assert.rejects(() => client.readFile('peerB', ''), /path/)
  })
})
