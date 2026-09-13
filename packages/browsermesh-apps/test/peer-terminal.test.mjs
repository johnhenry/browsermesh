/**
 * Tests for peer-terminal.mjs -- TerminalHost, TerminalClient, and
 * createTerminalService (the MeshService wrapper).
 *
 * Matches this family's established pattern for this kind of test
 * (peer-files.test.mjs, Phase 8, is the direct precedent): real
 * `PeerRegistry`s wired to real `MeshACL` (`@johnhenry/browsermesh-core`),
 * real Ed25519 `IdentityWallet`/`MeshIdentityManager` identities, connected
 * via a minimal duck-typed in-memory bus (not real WebRTC -- that's a
 * later phase's job).
 *
 * `TerminalHost#handleRequest()` (pure compute, no transport) is also
 * tested directly, independent of the mesh transport layer, for the
 * command-filtering/execution/truncation logic itself -- porting forward
 * the meaningful coverage the old `PeerSession`-based test file had,
 * adapted to the new pure-function shape.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/peer-terminal.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Provide crypto.randomUUID if not available
if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

import {
  TerminalHost,
  TerminalClient,
  TERMINAL_DEFAULTS,
  TERMINAL_RESOURCE,
  TERMINAL_ACTION,
  createTerminalService,
} from '../src/peer-terminal.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshNode } from '../src/mesh-bootstrap.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

// ---------------------------------------------------------------------------
// Test fixtures (mirrors peer-files.test.mjs's own)
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
 * A minimal duck-typed `PeerNode` pair, matching peer-files.test.mjs's own
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

/** Mock shell fixture matching TerminalHost's duck-typed interface. */
function createMockShell() {
  return {
    async execute(command) {
      if (command === 'error-cmd') throw new Error('shell error')
      return { output: `output of: ${command}`, exitCode: 0 }
    },
  }
}

// ---------------------------------------------------------------------------
// Tests — TERMINAL_DEFAULTS
// ---------------------------------------------------------------------------

describe('TERMINAL_DEFAULTS', () => {
  it('has correct values', () => {
    assert.equal(TERMINAL_DEFAULTS.maxOutputLength, 65536)
    assert.equal(TERMINAL_DEFAULTS.timeout, 30000)
    assert.ok(Array.isArray(TERMINAL_DEFAULTS.blockedCommands))
    assert.ok(TERMINAL_DEFAULTS.blockedCommands.includes('exit'))
    assert.ok(TERMINAL_DEFAULTS.blockedCommands.includes('shutdown'))
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(TERMINAL_DEFAULTS))
  })
})

describe('TERMINAL_RESOURCE / TERMINAL_ACTION', () => {
  it('is a single coarse checkAccess scope, not granted by any default acl.mjs template', () => {
    assert.equal(TERMINAL_RESOURCE, 'terminal')
    assert.equal(TERMINAL_ACTION, 'execute')
  })
})

// ---------------------------------------------------------------------------
// Tests — TerminalHost (direct, no transport -- pure request/response logic)
// ---------------------------------------------------------------------------

describe('TerminalHost#handleRequest (direct, no transport)', () => {
  let shell, host

  beforeEach(() => {
    shell = createMockShell()
    // No checkAccess supplied -- permissive default (see class doc comment).
    host = new TerminalHost({ shell })
  })

  it('throws when shell is missing', () => {
    assert.throws(() => new TerminalHost({}), /shell.*execute/)
  })

  it('throws when shell has no execute()', () => {
    assert.throws(() => new TerminalHost({ shell: {} }), /shell.*execute/)
  })

  it('executes a command via the shell and returns output/exitCode', async () => {
    const response = await host.handleRequest('peerA', { command: 'echo hello', requestId: 'req-1' })
    assert.equal(response.requestId, 'req-1')
    assert.equal(response.output, 'output of: echo hello')
    assert.equal(response.exitCode, 0)
  })

  it('returns null for a resize event (no response needed)', async () => {
    const response = await host.handleRequest('peerA', { resize: { cols: 80, rows: 24 } })
    assert.equal(response, null)
  })

  it('rejects a missing/empty command', async () => {
    const response = await host.handleRequest('peerA', { requestId: 'req-empty' })
    assert.match(response.output, /non-empty string/)
    assert.equal(response.exitCode, 1)
  })

  it('blocks disallowed (default-blocked) commands', async () => {
    const response = await host.handleRequest('peerA', { command: 'exit', requestId: 'req-exit' })
    assert.equal(response.exitCode, 126)
    assert.match(response.output, /not allowed/)
  })

  it('blocks shutdown', async () => {
    const response = await host.handleRequest('peerA', { command: 'shutdown now', requestId: 'req-sd' })
    assert.equal(response.exitCode, 126)
  })

  it('respects an allowlist', async () => {
    const restricted = new TerminalHost({ shell, allowedCommands: ['ls', 'pwd'] })
    const response = await restricted.handleRequest('peerA', { command: 'cat /etc/passwd', requestId: 'req-cat' })
    assert.equal(response.exitCode, 126)
    assert.match(response.output, /not allowed/)
  })

  it('truncates output exceeding maxOutputLength', async () => {
    const longShell = { async execute() { return { output: 'x'.repeat(200), exitCode: 0 } } }
    const smallHost = new TerminalHost({ shell: longShell, maxOutputLength: 50 })
    const response = await smallHost.handleRequest('peerA', { command: 'big-output', requestId: 'req-trunc' })
    assert.equal(response.output.length, 50)
    assert.equal(response.truncated, true)
  })

  it('turns a throwing shell into an error response, not a rejection', async () => {
    const response = await host.handleRequest('peerA', { command: 'error-cmd', requestId: 'req-err' })
    assert.equal(response.exitCode, 1)
    assert.match(response.output, /shell error/)
  })

  describe('checkAccess gating', () => {
    it('rejects execution when checkAccess denies, without ever calling the shell', async () => {
      let shellCalled = false
      const gatedShell = { async execute(cmd) { shellCalled = true; return { output: 'x', exitCode: 0 } } }
      const gatedHost = new TerminalHost({
        shell: gatedShell,
        checkAccess: () => ({ allowed: false, reason: 'no grant' }),
      })
      const response = await gatedHost.handleRequest('peerA', { command: 'ls', requestId: 'req-denied' })
      assert.equal(response.exitCode, 1)
      assert.equal(response.denied, true)
      assert.match(response.output, /not granted/)
      assert.match(response.output, /no grant/)
      assert.equal(shellCalled, false, 'shell.execute() must never be called for a denied request')
    })

    it('allows execution when checkAccess allows', async () => {
      const gatedHost = new TerminalHost({ shell, checkAccess: () => ({ allowed: true }) })
      const response = await gatedHost.handleRequest('peerA', { command: 'ls', requestId: 'req-ok' })
      assert.equal(response.exitCode, 0)
      assert.equal(response.denied, undefined)
    })

    it('passes the requesting pubKey to checkAccess', async () => {
      const seen = []
      const gatedHost = new TerminalHost({
        shell,
        checkAccess: (fromPubKey) => { seen.push(fromPubKey); return { allowed: true } },
      })
      await gatedHost.handleRequest('peer-xyz', { command: 'ls', requestId: 'r1' })
      assert.deepEqual(seen, ['peer-xyz'])
    })

    it('a resize event skips the checkAccess gate entirely (informational, no execution)', async () => {
      let checkAccessCalled = false
      const gatedHost = new TerminalHost({
        shell,
        checkAccess: () => { checkAccessCalled = true; return { allowed: false } },
      })
      const response = await gatedHost.handleRequest('peerA', { resize: { cols: 1, rows: 1 } })
      assert.equal(response, null)
      assert.equal(checkAccessCalled, false)
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — TerminalClient (direct, injected sendRequest)
// ---------------------------------------------------------------------------

describe('TerminalClient (direct, injected sendRequest)', () => {
  it('throws when sendRequest is missing', () => {
    assert.throws(() => new TerminalClient({}), /sendRequest/)
  })

  it('resolves execute() when a matching response arrives from the right peer', async () => {
    let capturedRequestId
    const client = new TerminalClient({
      sendRequest: (pubKey, payload) => { capturedRequestId = payload.requestId },
    })
    const promise = client.execute('peerB', 'ls -la')
    await new Promise((r) => setTimeout(r, 0))
    client.handleResponse('peerB', { requestId: capturedRequestId, output: 'file1\nfile2', exitCode: 0 })
    const result = await promise
    assert.equal(result.output, 'file1\nfile2')
    assert.equal(result.exitCode, 0)
  })

  it('rejects on timeout when no response ever arrives', async () => {
    const client = new TerminalClient({ sendRequest: () => {}, timeout: 30 })
    await assert.rejects(() => client.execute('peerB', 'slow-cmd'), /timed out/)
  })

  it('validates pubKey and command', async () => {
    const client = new TerminalClient({ sendRequest: () => {} })
    await assert.rejects(() => client.execute('', 'ls'), /pubKey/)
    await assert.rejects(() => client.execute('peerB', ''), /non-empty string/)
  })

  it('sendResize sends a resize payload with no requestId', () => {
    const sent = []
    const client = new TerminalClient({ sendRequest: (pubKey, payload) => sent.push({ pubKey, payload }) })
    client.sendResize('peerB', 120, 40)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].pubKey, 'peerB')
    assert.deepEqual(sent[0].payload.resize, { cols: 120, rows: 40 })
    assert.equal(sent[0].payload.requestId, undefined)
  })

  it('ignores a response whose requestId matches but the sender does not', async () => {
    const sent = []
    const client = new TerminalClient({
      sendRequest: (pubKey, payload) => { sent.push({ pubKey, payload }) },
      timeout: 40,
    })
    const promise = client.execute('peerB', 'ls')
    await new Promise((r) => setTimeout(r, 0))
    client.handleResponse('peerC', { requestId: sent[0].payload.requestId, output: 'WRONG', exitCode: 0 })
    await assert.rejects(() => promise, /timed out/)
  })

  it('two concurrent requests to different peers resolve independently', async () => {
    const sent = []
    const client = new TerminalClient({ sendRequest: (pubKey, payload) => { sent.push({ pubKey, payload }) } })
    const p1 = client.execute('peerB', 'cmd1')
    const p2 = client.execute('peerC', 'cmd2')
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(sent.length, 2)

    client.handleResponse('peerC', { requestId: sent[1].payload.requestId, output: 'C', exitCode: 0 })
    client.handleResponse('peerB', { requestId: sent[0].payload.requestId, output: 'B', exitCode: 0 })

    const [r1, r2] = await Promise.all([p1, p2])
    assert.equal(r1.output, 'B')
    assert.equal(r2.output, 'C')
  })

  it('close() rejects all pending requests', async () => {
    const client = new TerminalClient({ sendRequest: () => {} })
    const promise = client.execute('peerB', 'pending-cmd')
    client.close()
    await assert.rejects(() => promise, /TerminalClient closed/)
  })

  it('emits an "output" event on a successful response', async () => {
    let capturedRequestId
    const client = new TerminalClient({ sendRequest: (pubKey, payload) => { capturedRequestId = payload.requestId } })
    const events = []
    client.on('output', (data) => events.push(data))
    const promise = client.execute('peerB', 'ls')
    await new Promise((r) => setTimeout(r, 0))
    client.handleResponse('peerB', { requestId: capturedRequestId, output: 'ok', exitCode: 0 })
    await promise
    assert.equal(events.length, 1)
    assert.equal(events[0].output, 'ok')
  })
})

// ---------------------------------------------------------------------------
// Tests — createTerminalService, wired over a real mesh transport
// ---------------------------------------------------------------------------

describe('createTerminalService: mesh-wired TerminalHost/TerminalClient', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodeA
  /** @type {any} */ let nodeB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    ;({ nodeA, nodeB } = wireNodes(alice, bob))
  })

  it('throws when attached with no shell (safe-by-construction)', () => {
    assert.throws(
      () => attachService(nodeB, undefined, createTerminalService({})),
      /shell.*execute/,
    )
  })

  it('a client (alice) can execute commands on bob, once granted terminal:execute', async () => {
    bob.registry.grantCapabilities(alice.podId, ['terminal:execute'])

    const shell = createMockShell()
    attachService(nodeB, undefined, createTerminalService({ shell }))
    const { api } = attachService(nodeA, undefined, createTerminalService({ shell: createMockShell() }))

    const result = await api.execute(bob.podId, 'whoami')
    assert.equal(result.output, 'output of: whoami')
    assert.equal(result.exitCode, 0)
  })

  it('SECURITY: rejects an unauthorized peer\'s exec attempt without ever calling the host shell', async () => {
    // bob never grants alice terminal:execute -- default-deny.
    let executed = false
    const shell = { async execute(cmd) { executed = true; return { output: 'should never run', exitCode: 0 } } }
    attachService(nodeB, undefined, createTerminalService({ shell }))
    const { api } = attachService(nodeA, undefined, createTerminalService({ shell: createMockShell() }))

    const result = await api.execute(bob.podId, 'whoami')
    assert.equal(result.exitCode, 1)
    assert.match(result.output, /not granted/)
    assert.equal(executed, false, 'the host shell must never execute an unauthorized command')
  })

  it('emits terminal:request-denied for an unauthorized request and terminal:request-served for an authorized one', async () => {
    const shell = createMockShell()
    const { on } = attachService(nodeB, undefined, createTerminalService({ shell }))
    const { api } = attachService(nodeA, undefined, createTerminalService({ shell: createMockShell() }))

    const denied = []
    const served = []
    on('terminal:request-denied', (d) => denied.push(d))
    on('terminal:request-served', (d) => served.push(d))

    await api.execute(bob.podId, 'ls') // denied -- no grant yet
    assert.equal(denied.length, 1)
    assert.equal(served.length, 0)

    bob.registry.grantCapabilities(alice.podId, ['terminal:execute'])
    await api.execute(bob.podId, 'ls') // now served
    assert.equal(served.length, 1)
  })

  it('concurrent requests to the same peer do not cross-correlate', async () => {
    bob.registry.grantCapabilities(alice.podId, ['terminal:execute'])
    const shell = createMockShell()
    attachService(nodeB, undefined, createTerminalService({ shell }))
    const { api } = attachService(nodeA, undefined, createTerminalService({ shell: createMockShell() }))

    const [a, b] = await Promise.all([
      api.execute(bob.podId, 'cmd-a'),
      api.execute(bob.podId, 'cmd-b'),
    ])
    assert.equal(a.output, 'output of: cmd-a')
    assert.equal(b.output, 'output of: cmd-b')
  })

  it('a response from a different peer than the one requested is ignored (not cross-correlated)', async () => {
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

    bob.registry.grantCapabilities(alice.podId, ['terminal:execute'])

    const { api: aliceApi } = attachService(nA, undefined, createTerminalService({ shell: createMockShell(), timeout: 150 }))
    attachService(nB, undefined, createTerminalService({ shell: createMockShell() })) // never responds

    const promise = aliceApi.execute(bob.podId, 'ls')

    // Snoop the outbound request from alice to bob to steal its requestId,
    // then have carol forge a response using that id.
    let requestId
    listenersB.add((fromPubKey, msg) => { requestId = msg.requestId })
    await new Promise((r) => setTimeout(r, 10))
    assert.ok(requestId, 'expected to observe the outbound requestId')

    queueMicrotask(() => {
      for (const cb of listenersA) {
        cb(carol.podId, { type: 'terminal-response', requestId, output: 'FORGED', exitCode: 0 })
      }
    })

    await assert.rejects(() => promise, /timed out/)
  })

  it('resize events do not produce a response', async () => {
    bob.registry.grantCapabilities(alice.podId, ['terminal:execute'])
    const shell = createMockShell()
    attachService(nodeB, undefined, createTerminalService({ shell }))
    const { api } = attachService(nodeA, undefined, createTerminalService({ shell: createMockShell() }))

    // Should not throw, hang, or produce any observable response traffic.
    api.sendResize(bob.podId, 100, 30)
    await new Promise((r) => setTimeout(r, 20))
  })
})

// ---------------------------------------------------------------------------
// Tests — timeout (host never responds)
// ---------------------------------------------------------------------------

describe('createTerminalService: timeout', () => {
  it('rejects when the target peer never responds', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = wireBlackHole(alice)

    const { api } = attachService(nodeA, undefined, createTerminalService({ shell: createMockShell(), timeout: 50 }))

    await assert.rejects(
      () => api.execute(bob.podId, 'slow-cmd'),
      /timed out/,
    )
  })
})

// ---------------------------------------------------------------------------
// Tests — teardown
// ---------------------------------------------------------------------------

describe('createTerminalService: teardown', () => {
  it('rejects pending requests on teardown', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    bob.registry.grantCapabilities(alice.podId, ['terminal:execute'])
    attachService(nodeB, undefined, createTerminalService({ shell: createMockShell() }))
    const { api, teardown } = attachService(nodeA, undefined, createTerminalService({ shell: createMockShell(), timeout: 200 }))

    const pending = api.execute(bob.podId, 'ls')
    await teardown()
    await assert.rejects(() => pending, /closed/)
  })
})

// =============================================================================
// createMeshNode({ enableTerminal: true }) -- opt-in surface (issue #84,
// Phase 10, unblocked by issue #86)
// =============================================================================
// Mirrors peer-escrow.test.mjs's own "createMeshNode({ enableEscrow: true })"
// integration section: real createMeshNode() PeerNodes, skipBoot: true where
// the test doesn't need actual discovery/WebRTC boot, just construction and
// the opt-in wiring surface itself.

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} }
}

describe('createMeshNode({ enableTerminal: true })', () => {
  it('leaves node.terminal unset and node.services empty of "terminal" when enableTerminal is omitted', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
    })

    assert.equal(node.terminal, undefined)
    assert.equal(node.services.has('terminal'), false)
  })

  it('throws when enableTerminal is set but terminalOptions.shell is missing', async () => {
    await assert.rejects(
      () => createMeshNode({
        label: 'alice',
        signalingTransport: createStubSignalingTransport(),
        enableTerminal: true,
        skipBoot: true,
      }),
      /shell is required/,
    )
  })

  it('attaches node.terminal (== node.services.get("terminal")) when enableTerminal + terminalOptions.shell are set', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableTerminal: true,
      terminalOptions: { shell: createMockShell() },
      skipBoot: true,
    })

    assert.ok(node.terminal, 'node.terminal is attached')
    assert.equal(node.terminal, node.services.get('terminal'))
    assert.equal(typeof node.terminal.api.execute, 'function')
    assert.equal(typeof node.terminal.api.sendResize, 'function')
  })
})
