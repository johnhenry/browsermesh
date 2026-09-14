/**
 * Tests for marketplace.mjs's network layer (Phase 2 of the marketplace/
 * quotas modernization plan -- see that file's own module doc comment):
 * `createMarketplaceNetworkService()` and `MeshMarketplace`.
 *
 * Matches this family's established pattern for this kind of test
 * (mesh-rpc.test.mjs / cloud-storage.test.mjs are the direct precedents):
 * real `PeerRegistry`s wired to real `MeshACL` (`@johnhenry/browsermesh-core`),
 * real Ed25519 `IdentityWallet`/`MeshIdentityManager` identities, connected
 * via a minimal duck-typed in-memory bus routed by destination pubkey (not
 * real WebRTC -- that's a later phase's job).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/marketplace-network.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  Marketplace,
  ServiceListing,
  ServiceReview,
  MeshMarketplace,
  createMarketplaceNetworkService,
  DEFAULT_MARKETPLACE_ENVELOPE_TYPE,
} from '../src/marketplace.mjs'
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

/** A shared in-memory bus for an arbitrary number of duck-typed `PeerNode`s, routed by destination pubkey (mirrors cloud-storage.test.mjs's own `createBus()`). */
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

/** Mark `remote.podId` as a known, connected peer in `local.registry`. */
function markConnected(local, remote) {
  local.registry.addPeer(remote.podId)
  local.registry.connect(remote.podId)
}

function makeListing(overrides = {}) {
  return new ServiceListing({
    id: 'svc-1',
    name: 'GPT Proxy',
    description: 'proxy to gpt models',
    providerPodId: 'placeholder',
    category: 'ai',
    ...overrides,
  })
}

describe('createMarketplaceNetworkService: construction', () => {
  it('throws without a marketplace', () => {
    assert.throws(() => createMarketplaceNetworkService({}), /opts\.marketplace.*is required/);
  });
});

describe('MeshMarketplace: construction', () => {
  it('throws without a node', () => {
    assert.throws(() => new MeshMarketplace({}), /opts\.node.*is required/);
  });
});

describe('MeshMarketplace: local pass-throughs behave exactly like Marketplace', () => {
  it('publish/search/getStats delegate to the composed local Marketplace', async () => {
    const bus = createBus();
    const alice = await createPeer('alice');
    const mp = new MeshMarketplace({ node: bus.nodeFor(alice) });
    try {
      mp.publish(makeListing({ id: 'local-1', providerPodId: mp.localPodId }));
      assert.equal(mp.search({ category: 'ai' }).length, 1);
      assert.equal(mp.getStats().totalListings, 1);
    } finally {
      await mp.close();
    }
  });

  it('forwards Marketplace\'s own local events onto its own bus verbatim', async () => {
    const bus = createBus();
    const alice = await createPeer('alice');
    const mp = new MeshMarketplace({ node: bus.nodeFor(alice) });
    try {
      const seen = [];
      mp.onEvent((event) => seen.push(event));
      mp.publish(makeListing({ id: 'fwd-1', providerPodId: mp.localPodId }));
      assert.deepEqual(seen, ['marketplace:listing-published']);
    } finally {
      await mp.close();
    }
  });
});

describe('MeshMarketplace: searchNetwork()', () => {
  it("finds a remote peer's published listing", async () => {
    const bus = createBus();
    const alice = await createPeer('alice');
    const bob = await createPeer('bob');
    const mpAlice = new MeshMarketplace({ node: bus.nodeFor(alice) });
    const mpBob = new MeshMarketplace({ node: bus.nodeFor(bob) });

    try {
      mpBob.publish(makeListing({ id: 'bob-svc', providerPodId: bob.podId, category: 'ai' }));
      markConnected(alice, bob);

      const results = await mpAlice.searchNetwork({ category: 'ai' }, { peerIds: [bob.podId] });
      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'bob-svc');
      assert.ok(results[0] instanceof ServiceListing);
    } finally {
      await mpAlice.close();
      await mpBob.close();
    }
  });

  it('defaults peerIds to currently-connected peers when omitted', async () => {
    const bus = createBus();
    const alice = await createPeer('alice');
    const bob = await createPeer('bob');
    const mpAlice = new MeshMarketplace({ node: bus.nodeFor(alice) });
    const mpBob = new MeshMarketplace({ node: bus.nodeFor(bob) });

    try {
      mpBob.publish(makeListing({ id: 'bob-svc-2', providerPodId: bob.podId }));
      markConnected(alice, bob);

      const results = await mpAlice.searchNetwork();
      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'bob-svc-2');
    } finally {
      await mpAlice.close();
      await mpBob.close();
    }
  });

  it('dedups a listing id returned by more than one peer', async () => {
    const bus = createBus();
    const alice = await createPeer('alice');
    const bob = await createPeer('bob');
    const carol = await createPeer('carol');
    const mpAlice = new MeshMarketplace({ node: bus.nodeFor(alice) });
    const mpBob = new MeshMarketplace({ node: bus.nodeFor(bob) });
    const mpCarol = new MeshMarketplace({ node: bus.nodeFor(carol) });

    try {
      // Same listing id "mirrored" on two peers -- searchNetwork must not double-count it.
      mpBob.publish(makeListing({ id: 'shared-1', providerPodId: bob.podId }));
      mpCarol.publish(makeListing({ id: 'shared-1', providerPodId: bob.podId }));
      markConnected(alice, bob);
      markConnected(alice, carol);

      const results = await mpAlice.searchNetwork({}, { peerIds: [bob.podId, carol.podId] });
      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'shared-1');
    } finally {
      await mpAlice.close();
      await mpBob.close();
      await mpCarol.close();
    }
  });

  it('excludes a non-responding peer from the result instead of rejecting the whole call', async () => {
    const bus = createBus();
    const alice = await createPeer('alice');
    const bob = await createPeer('bob');
    const mpAlice = new MeshMarketplace({ node: bus.nodeFor(alice) });
    const mpBob = new MeshMarketplace({ node: bus.nodeFor(bob) });

    try {
      mpBob.publish(makeListing({ id: 'bob-svc-3', providerPodId: bob.podId }));
      markConnected(alice, bob);
      // "unreachable-pod" is never connected/registered on the bus -- sendTo() to it is a silent no-op,
      // so the request to it will simply never get a response and must time out.
      const results = await mpAlice.searchNetwork({}, { peerIds: [bob.podId, 'unreachable-pod'], timeoutMs: 100 });
      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'bob-svc-3');
    } finally {
      await mpAlice.close();
      await mpBob.close();
    }
  });

  it('returns an empty array when there are no target peers', async () => {
    const bus = createBus();
    const alice = await createPeer('alice');
    const mp = new MeshMarketplace({ node: bus.nodeFor(alice) });
    try {
      const results = await mp.searchNetwork();
      assert.deepEqual(results, []);
    } finally {
      await mp.close();
    }
  });
});

describe('MeshMarketplace: getReviewsNetwork()', () => {
  it("fetches a remote peer's reviews for a listing", async () => {
    const bus = createBus();
    const alice = await createPeer('alice');
    const bob = await createPeer('bob');
    const mpAlice = new MeshMarketplace({ node: bus.nodeFor(alice) });
    const mpBob = new MeshMarketplace({ node: bus.nodeFor(bob) });

    try {
      mpBob.publish(makeListing({ id: 'reviewed-1', providerPodId: bob.podId }));
      mpBob.addReview(new ServiceReview({ id: 'r1', listingId: 'reviewed-1', reviewerPodId: 'someone-else', rating: 5 }));
      markConnected(alice, bob);

      const reviews = await mpAlice.getReviewsNetwork('reviewed-1', { peerIds: [bob.podId] });
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0].id, 'r1');
    } finally {
      await mpAlice.close();
      await mpBob.close();
    }
  });
});

describe('createMarketplaceNetworkService: envelope isolation', () => {
  it('uses a dedicated envelope type, not the shared mesh-rpc default', () => {
    assert.equal(DEFAULT_MARKETPLACE_ENVELOPE_TYPE, 'mesh-marketplace');
  });
});
