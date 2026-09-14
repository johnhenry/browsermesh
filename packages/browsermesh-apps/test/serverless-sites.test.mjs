/**
 * Tests for serverless-sites.mjs (Phase 5 of the BrowserMesh Serverless
 * plan -- see that file's own module doc comment).
 *
 * Uses a fake `peerNode` duck-typed to just `listPeers({status})`, matching
 * `@johnhenry/browsermesh-core`'s real `PeerState` shape (`{fingerprint,
 * status, ...}`) -- exactly what a real `PeerNode.listPeers()` returns.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/serverless-sites.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { SiteRegistry } from '../src/serverless-sites.mjs'

/** @param {Array<{fingerprint: string, status?: string}>} peers */
function fakePeerNode(peers) {
  return {
    listPeers(filter = {}) {
      return peers.filter((p) => !filter.status || (p.status || 'connected') === filter.status)
    },
  }
}

describe('SiteRegistry: construction', () => {
  it('throws without a peerNode with listPeers()', () => {
    assert.throws(() => new SiteRegistry({}), /opts.peerNode.*is required/)
    assert.throws(() => new SiteRegistry({ peerNode: {} }), /opts.peerNode.*is required/)
  })
})

describe('SiteRegistry: registration bookkeeping', () => {
  it('registerSitePeer/listSitePeers/unregisterSitePeer round-trip', () => {
    const registry = new SiteRegistry({ peerNode: fakePeerNode([]) })
    registry.registerSitePeer('my-blog', 'pod-a')
    registry.registerSitePeer('my-blog', 'pod-b')
    assert.deepEqual(new Set(registry.listSitePeers('my-blog')), new Set(['pod-a', 'pod-b']))

    registry.unregisterSitePeer('my-blog', 'pod-a')
    assert.deepEqual(registry.listSitePeers('my-blog'), ['pod-b'])
  })

  it('unregistering the last peer for a site cleans up the entry entirely', () => {
    const registry = new SiteRegistry({ peerNode: fakePeerNode([]) })
    registry.registerSitePeer('my-blog', 'pod-a')
    registry.unregisterSitePeer('my-blog', 'pod-a')
    assert.deepEqual(registry.listSitePeers('my-blog'), [])
  })

  it('listSitePeers on an unknown site returns an empty array', () => {
    const registry = new SiteRegistry({ peerNode: fakePeerNode([]) })
    assert.deepEqual(registry.listSitePeers('never-registered'), [])
  })
})

describe('SiteRegistry: selectPeer', () => {
  it('returns null for a site with no registered peers', () => {
    const registry = new SiteRegistry({ peerNode: fakePeerNode([]) })
    assert.equal(registry.selectPeer('unknown-site'), null)
  })

  it('returns null when registered peers exist but none are currently connected', () => {
    const registry = new SiteRegistry({ peerNode: fakePeerNode([{ fingerprint: 'pod-a', status: 'disconnected' }]) })
    registry.registerSitePeer('my-blog', 'pod-a')
    assert.equal(registry.selectPeer('my-blog'), null)
  })

  it('only selects a peer that is BOTH registered AND currently connected', () => {
    const registry = new SiteRegistry({
      peerNode: fakePeerNode([
        { fingerprint: 'pod-a', status: 'connected' }, // registered, connected -- eligible
        { fingerprint: 'pod-b', status: 'connected' }, // connected but never registered for this site -- must never be picked
      ]),
    })
    registry.registerSitePeer('my-blog', 'pod-a')
    assert.equal(registry.selectPeer('my-blog'), 'pod-a')
  })

  it('round-robins across registered+connected peers by default', () => {
    const registry = new SiteRegistry({
      peerNode: fakePeerNode([
        { fingerprint: 'pod-a', status: 'connected' },
        { fingerprint: 'pod-b', status: 'connected' },
      ]),
    })
    registry.registerSitePeer('my-blog', 'pod-a')
    registry.registerSitePeer('my-blog', 'pod-b')
    const first = registry.selectPeer('my-blog')
    const second = registry.selectPeer('my-blog')
    assert.notEqual(first, second, 'round-robin should not pick the same peer twice in a row across two peers')
  })

  it('respects an injected getLoad() under the load-balanced policy', () => {
    const registry = new SiteRegistry({
      peerNode: fakePeerNode([
        { fingerprint: 'pod-a', status: 'connected' },
        { fingerprint: 'pod-b', status: 'connected' },
      ]),
      policy: 'load-balanced',
      getLoad: (podId) => (podId === 'pod-b' ? 0 : 99),
    })
    registry.registerSitePeer('my-blog', 'pod-a')
    registry.registerSitePeer('my-blog', 'pod-b')
    assert.equal(registry.selectPeer('my-blog'), 'pod-b')
  })

  it('defaults every peer\'s load to 0 when no getLoad is supplied (no fabricated signal)', () => {
    const registry = new SiteRegistry({
      peerNode: fakePeerNode([{ fingerprint: 'pod-a', status: 'connected' }]),
      policy: 'load-balanced',
    })
    registry.registerSitePeer('my-blog', 'pod-a')
    assert.equal(registry.selectPeer('my-blog'), 'pod-a')
  })

  it('maintains independent round-robin cursors per site', () => {
    const registry = new SiteRegistry({
      peerNode: fakePeerNode([
        { fingerprint: 'pod-a', status: 'connected' },
        { fingerprint: 'pod-b', status: 'connected' },
      ]),
    })
    registry.registerSitePeer('site-1', 'pod-a')
    registry.registerSitePeer('site-1', 'pod-b')
    registry.registerSitePeer('site-2', 'pod-a')
    registry.registerSitePeer('site-2', 'pod-b')

    const site1First = registry.selectPeer('site-1')
    const site2First = registry.selectPeer('site-2')
    assert.equal(site1First, site2First, 'both sites\' cursors start fresh, so their first picks should match')
  })
})
