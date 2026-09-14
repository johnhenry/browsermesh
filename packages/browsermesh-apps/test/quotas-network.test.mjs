/**
 * Tests for quotas.mjs's network layer (Phase 4 of the marketplace/quotas
 * modernization plan -- see that file's own module doc comment):
 * `createQuotaReportingService()` and `MeshQuotaEnforcer`.
 *
 * Matches this family's established pattern for this kind of test
 * (mesh-rpc.test.mjs / cloud-storage.test.mjs are the direct precedents):
 * real `PeerRegistry`s wired to real `MeshACL` (`@johnhenry/browsermesh-core`),
 * real Ed25519 `IdentityWallet`/`MeshIdentityManager` identities, connected
 * via a minimal duck-typed in-memory bus routed by destination pubkey (not
 * real WebRTC -- that's a later phase's job).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/quotas-network.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  MeshQuotaEnforcer,
  createQuotaReportingService,
  DEFAULT_QUOTA_ENVELOPE_TYPE,
} from '../src/quotas.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

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

/** A shared in-memory bus for an arbitrary number of duck-typed `PeerNode`s, routed by destination pubkey (mirrors cloud-storage.test.mjs's/marketplace-network.test.mjs's own `createBus()`). */
function createBus() {
  const listenersByPod = new Map()
  return {
    nodeFor(peer) {
      const { podId, wallet, registry } = peer
      if (!listenersByPod.has(podId)) listenersByPod.set(podId, new Set())
      return {
        podId,
        wallet,
        registry,
        onIncomingData(cb) {
          const set = listenersByPod.get(podId)
          set.add(cb)
          return () => set.delete(cb)
        },
        async sendTo(pubKey, data) {
          const set = listenersByPod.get(pubKey)
          if (!set) return
          queueMicrotask(() => {
            for (const cb of set) cb(podId, data)
          })
        },
      }
    },
  }
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs` (mirrors cloud-storage.test.mjs's own `waitFor()`). */
async function waitFor(fn, timeoutMs = 1000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

describe('createQuotaReportingService: construction', () => {
  it('throws without an enforcer', () => {
    assert.throws(() => createQuotaReportingService({}), /opts\.enforcer.*is required/)
  })
})

describe('MeshQuotaEnforcer: construction', () => {
  it('throws without a node', () => {
    assert.throws(() => new MeshQuotaEnforcer({}), /opts\.node.*is required/)
  })

  it('uses a dedicated envelope type, not the shared mesh-rpc default', () => {
    assert.equal(DEFAULT_QUOTA_ENVELOPE_TYPE, 'quota-reporting')
  })
})

describe('MeshQuotaEnforcer: reportUsage() attribution', () => {
  it("attributes usage to the sender's real podId, regardless of anything the payload could claim (there is no podId field to spoof)", async () => {
    const bus = createBus()
    const alice = await createPeer('alice') // authority
    const bob = await createPeer('bob')     // reporter
    const authority = new MeshQuotaEnforcer({ node: bus.nodeFor(alice) })
    const reporter = new MeshQuotaEnforcer({ node: bus.nodeFor(bob) })

    try {
      authority.manager.setQuota(bob.podId, { cpuMs: 1000 })
      await reporter.reportUsage(alice.podId, 'cpuMs', 200)

      await waitFor(() => authority.enforcer.getUsage(bob.podId) !== null, 500, 'authority to record bob\'s usage')
      const usage = authority.enforcer.getUsage(bob.podId)
      assert.equal(usage.usage.cpuMs, 200)
      // Nothing was ever recorded under any OTHER podId -- there's no
      // field in the wire message a reporter could have used to claim one.
      assert.equal(authority.enforcer.getUsage(alice.podId), null)
    } finally {
      await authority.close()
      await reporter.close()
    }
  })
});

describe('MeshQuotaEnforcer: violation reply', () => {
  it("a violation on the authority triggers a 'quota-violation' reply, seen on the reporting side as 'quota:violation-notified'", async () => {
    const bus = createBus()
    const alice = await createPeer('alice') // authority
    const bob = await createPeer('bob')     // reporter
    const authority = new MeshQuotaEnforcer({ node: bus.nodeFor(alice) })
    const reporter = new MeshQuotaEnforcer({ node: bus.nodeFor(bob) })

    try {
      authority.manager.setQuota(bob.podId, { cpuMs: 50 })

      let notified = null
      reporter.on('quota:violation-notified', (data) => { notified = data })

      await reporter.reportUsage(alice.podId, 'cpuMs', 100)

      await waitFor(() => notified !== null, 500, "reporter to see 'quota:violation-notified'")
      assert.equal(notified.from, alice.podId)
      assert.equal(notified.violation.podId, bob.podId)
      assert.equal(notified.violation.resource, 'cpuMs')
    } finally {
      await authority.close()
      await reporter.close()
    }
  })

  it("a report that does NOT trip a violation gets no reply, only 'quota:usage-report-received' on the authority side", async () => {
    const bus = createBus()
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const authority = new MeshQuotaEnforcer({ node: bus.nodeFor(alice) })
    const reporter = new MeshQuotaEnforcer({ node: bus.nodeFor(bob) })

    try {
      authority.manager.setQuota(bob.podId, { cpuMs: 1000 })

      let received = null
      authority.on('quota:usage-report-received', (data) => { received = data })
      let notified = false
      reporter.on('quota:violation-notified', () => { notified = true })

      await reporter.reportUsage(alice.podId, 'cpuMs', 10)

      await waitFor(() => received !== null, 500, "authority to see 'quota:usage-report-received'")
      assert.equal(received.from, bob.podId)
      assert.equal(received.resource, 'cpuMs')
      assert.equal(received.amount, 10)
      assert.equal(notified, false, 'no violation reply should have been sent');
    } finally {
      await authority.close()
      await reporter.close()
    }
  })
});

describe('MeshQuotaEnforcer: quota-update is notification-only', () => {
  it("pushQuotaUpdate() delivers 'quota:rule-update-received' but never mutates the receiving peer's own QuotaManager", async () => {
    const bus = createBus()
    const alice = await createPeer('alice') // authority, pushes a rule
    const bob = await createPeer('bob')     // receiving peer
    const authority = new MeshQuotaEnforcer({ node: bus.nodeFor(alice) })
    const receiver = new MeshQuotaEnforcer({ node: bus.nodeFor(bob) })

    try {
      const rule = authority.manager.setQuota(bob.podId, { cpuMs: 42 })

      let received = null
      receiver.on('quota:rule-update-received', (data) => { received = data })

      await authority.pushQuotaUpdate(bob.podId, rule)

      await waitFor(() => received !== null, 500, "receiver to see 'quota:rule-update-received'")
      assert.equal(received.from, alice.podId)
      assert.equal(received.rule.podId, bob.podId)
      assert.equal(received.rule.limits.cpuMs, 42)

      // The receiving peer's OWN QuotaManager (a fresh, separate instance)
      // must be completely untouched -- no auto-apply.
      assert.equal(receiver.manager.getQuota(bob.podId), null);
    } finally {
      await authority.close()
      await receiver.close()
    }
  })

  it('a caller can opt in explicitly at the call site to actually trust a pushed rule', async () => {
    const bus = createBus()
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const authority = new MeshQuotaEnforcer({ node: bus.nodeFor(alice) })
    const receiver = new MeshQuotaEnforcer({ node: bus.nodeFor(bob) })

    try {
      const rule = authority.manager.setQuota(bob.podId, { cpuMs: 99 })

      // Explicit opt-in wiring, done entirely at the call site -- not
      // anything the service itself does automatically.
      receiver.on('quota:rule-update-received', ({ from, rule: pushed }) => {
        if (from === alice.podId) {
          receiver.manager.setQuota(pushed.podId, pushed.limits, pushed.overagePolicy);
        }
      });

      await authority.pushQuotaUpdate(bob.podId, rule)
      await waitFor(() => receiver.manager.getQuota(bob.podId) !== null, 500, 'the opted-in caller to apply the pushed rule')

      assert.equal(receiver.manager.getQuota(bob.podId).limits.cpuMs, 99)
    } finally {
      await authority.close()
      await receiver.close()
    }
  })
});
