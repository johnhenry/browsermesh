/**
 * Unit-level test for `createMeshNode()`'s `enableAudit`/`auditChain`
 * plumbing (issue #85).
 *
 * `packages/browsermesh-apps/src/audit.mjs`'s `AuditChain` -- and
 * `PeerNode`'s existing "audit trail for every session action" path (see
 * `peer-node.mjs`'s `#audit()`, called from `boot()`, `connectToPeer()`,
 * `adoptIncomingSession()`, and `shutdown()`) -- were both real and tested
 * in isolation, but nothing in `createMeshNode()` ever actually constructed
 * an `AuditChain` and passed it through, so the whole path was permanently
 * dead in production. This asserts the new `enableAudit`/`auditChain`
 * options actually wire a real `AuditChain` in, and that PeerNode's audit
 * calls produce real, independently-verifiable entries once they do.
 *
 * No real WebRTC/`node-datachannel` is needed here: `PeerNode.boot()`
 * itself is audit-logged, and `connectToPeer()` with no `endpoints` falls
 * back to `PeerRegistry.connect()`'s in-memory bookkeeping (see
 * `peer.mjs`'s `MeshPeerManager.connect()`) without ever touching a real
 * transport -- both are exercised against real `PeerNode`/`PeerRegistry`
 * instances, same as `test/mesh-bootstrap.test.mjs`.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-bootstrap-audit.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

const { createMeshNode } = await import('../src/mesh-bootstrap.mjs')
const { AuditChain } = await import('../src/audit.mjs')
const { ManualStrategy } = await import('@johnhenry/browsermesh-discovery')

/** Stub signaling transport -- MeshSignalingChannel only requires
 * send(msg)/onMessage(cb); see signaling.mjs. Never actually used here
 * since no real WebRTC offer/answer is exchanged. */
function createStubSignalingTransport() {
  return { send() {}, onMessage() {} }
}

describe('createMeshNode: enableAudit/auditChain wiring (issue #85)', () => {
  it('enableAudit: true constructs a real AuditChain, attaches it as node.auditChain, and PeerNode actually appends verifiable entries', async () => {
    const node = await createMeshNode({
      label: 'alice',
      discoveryStrategies: [new ManualStrategy()],
      signalingTransport: createStubSignalingTransport(),
      enableAudit: true,
    })

    try {
      assert.ok(node.auditChain instanceof AuditChain, 'node.auditChain is a real AuditChain instance')
      assert.equal(node.auditChain.chainId, `audit-${node.podId}`, 'default chainId is audit-${podId}')

      // boot() is already documented (peer-node.mjs) as audit-logged --
      // createMeshNode() calls it by default, so an entry should exist
      // with no further action needed.
      assert.equal(node.auditChain.length, 1, 'boot() produced exactly one audit entry')
      const bootEntry = node.auditChain.get(0)
      assert.equal(bootEntry.operation, 'peer-node:boot')
      assert.equal(bootEntry.authorPodId, node.podId)
      assert.ok(bootEntry.signature, 'the boot entry is signed')

      // connectToPeer() is also documented as audit-logged ("Creates a
      // session entry and logs the connection to the audit chain"). With no
      // endpoints, it falls back to PeerRegistry's in-memory connect() --
      // no real transport required.
      await node.connectToPeer('fake-remote-pod-id')
      assert.equal(node.auditChain.length, 2, 'connectToPeer() appended a second audit entry')
      assert.equal(node.auditChain.get(1).operation, 'peer-node:connect')

      // The whole chain -- hash linkage + Ed25519 signatures -- verifies
      // against the node's own real identity.
      const result = await node.auditChain.verify((podId) => node.wallet.getPublicKeyBytes(podId))
      assert.deepEqual(result, { valid: true })

      // shutdown() is documented as audit-logged too.
      await node.shutdown()
      assert.equal(node.auditChain.length, 3, 'shutdown() appended a third audit entry')
      assert.equal(node.auditChain.get(2).operation, 'peer-node:shutdown')

      const finalResult = await node.auditChain.verify((podId) => node.wallet.getPublicKeyBytes(podId))
      assert.deepEqual(finalResult, { valid: true }, 'the chain still verifies after shutdown')
    } finally {
      if (node.state !== 'stopped') await node.shutdown()
      await node.signaling.close()
    }
  })

  it('auditChain: <instance> lets a caller supply their own pre-built AuditChain, taking precedence over enableAudit', async () => {
    const myChain = new AuditChain('my-own-chain-id')

    const node = await createMeshNode({
      label: 'bob',
      discoveryStrategies: [new ManualStrategy()],
      signalingTransport: createStubSignalingTransport(),
      enableAudit: true, // deliberately also set, to prove auditChain wins
      auditChain: myChain,
    })

    try {
      assert.equal(node.auditChain, myChain, 'the caller-supplied instance is used verbatim, not a new default one')
      assert.equal(myChain.chainId, 'my-own-chain-id')
      assert.equal(myChain.length, 1, "the caller's own instance received PeerNode's real boot entry")
    } finally {
      await node.shutdown()
      await node.signaling.close()
    }
  })

  it('auditChainId overrides the default chainId when enableAudit constructs its own AuditChain', async () => {
    const node = await createMeshNode({
      label: 'carol',
      discoveryStrategies: [new ManualStrategy()],
      signalingTransport: createStubSignalingTransport(),
      enableAudit: true,
      auditChainId: 'carols-custom-chain',
    })

    try {
      assert.equal(node.auditChain.chainId, 'carols-custom-chain')
    } finally {
      await node.shutdown()
      await node.signaling.close()
    }
  })

  it('omitting both enableAudit and auditChain leaves node.auditChain unset and changes no existing behaviour', async () => {
    const node = await createMeshNode({
      label: 'dave',
      discoveryStrategies: [new ManualStrategy()],
      signalingTransport: createStubSignalingTransport(),
    })

    try {
      assert.equal(node.auditChain, undefined, 'node.auditChain is never set when audit was not opted into')

      // Normal lifecycle is unaffected: PeerNode's #audit() no-ops silently
      // when no AuditChain was ever injected (see peer-node.mjs).
      assert.equal(node.state, 'running')
      await node.connectToPeer('fake-remote-pod-id')
      assert.ok(node.hasActiveSession('fake-remote-pod-id'))
    } finally {
      await node.shutdown()
      await node.signaling.close()
    }
  })
})
