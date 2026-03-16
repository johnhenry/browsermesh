import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRUST_CATEGORIES,
  createTrustEdge,
  computeTransitiveTrust,
} from '../src/trust.mjs';

describe('TRUST_CATEGORIES', () => {
  it('has expected categories', () => {
    assert.equal(TRUST_CATEGORIES.DIRECT, 'direct');
    assert.equal(TRUST_CATEGORIES.TRANSITIVE, 'transitive');
    assert.equal(TRUST_CATEGORIES.MEMBERSHIP, 'membership');
    assert.equal(TRUST_CATEGORIES.REPUTATION, 'reputation');
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(TRUST_CATEGORIES));
  });
});

describe('createTrustEdge', () => {
  it('creates a frozen edge with all fields', () => {
    const edge = createTrustEdge({
      from: 'a',
      to: 'b',
      category: TRUST_CATEGORIES.DIRECT,
      value: 0.8,
      timestamp: 1000,
    });
    assert.equal(edge.from, 'a');
    assert.equal(edge.to, 'b');
    assert.equal(edge.category, 'direct');
    assert.equal(edge.value, 0.8);
    assert.equal(edge.timestamp, 1000);
    assert.ok(Object.isFrozen(edge));
  });

  it('defaults timestamp to Date.now()', () => {
    const before = Date.now();
    const edge = createTrustEdge({
      from: 'a',
      to: 'b',
      category: TRUST_CATEGORIES.DIRECT,
      value: 0.5,
    });
    const after = Date.now();
    assert.ok(edge.timestamp >= before && edge.timestamp <= after);
  });

  it('throws RangeError for value < 0', () => {
    assert.throws(
      () => createTrustEdge({ from: 'a', to: 'b', category: 'direct', value: -0.1 }),
      RangeError
    );
  });

  it('throws RangeError for value > 1', () => {
    assert.throws(
      () => createTrustEdge({ from: 'a', to: 'b', category: 'direct', value: 1.1 }),
      RangeError
    );
  });

  it('accepts boundary values 0 and 1', () => {
    const e0 = createTrustEdge({ from: 'a', to: 'b', category: 'direct', value: 0 });
    assert.equal(e0.value, 0);
    const e1 = createTrustEdge({ from: 'a', to: 'b', category: 'direct', value: 1 });
    assert.equal(e1.value, 1);
  });
});

describe('computeTransitiveTrust', () => {
  it('returns 1.0 when source equals target', () => {
    assert.equal(computeTransitiveTrust([], 'a', 'a'), 1.0);
  });

  it('returns 0 when no edges exist', () => {
    assert.equal(computeTransitiveTrust([], 'a', 'b'), 0);
  });

  it('returns direct trust for single-hop path', () => {
    const edges = [
      createTrustEdge({ from: 'a', to: 'b', category: 'direct', value: 0.9 }),
    ];
    assert.equal(computeTransitiveTrust(edges, 'a', 'b'), 0.9);
  });

  it('multiplies trust along a two-hop path', () => {
    const edges = [
      createTrustEdge({ from: 'a', to: 'b', category: 'direct', value: 0.8 }),
      createTrustEdge({ from: 'b', to: 'c', category: 'direct', value: 0.5 }),
    ];
    const trust = computeTransitiveTrust(edges, 'a', 'c');
    assert.ok(Math.abs(trust - 0.4) < 1e-10);
  });

  it('takes the maximum across multiple paths', () => {
    const edges = [
      // Path 1: a -> b -> d: 0.5 * 0.5 = 0.25
      createTrustEdge({ from: 'a', to: 'b', category: 'direct', value: 0.5 }),
      createTrustEdge({ from: 'b', to: 'd', category: 'direct', value: 0.5 }),
      // Path 2: a -> c -> d: 0.9 * 0.9 = 0.81
      createTrustEdge({ from: 'a', to: 'c', category: 'direct', value: 0.9 }),
      createTrustEdge({ from: 'c', to: 'd', category: 'direct', value: 0.9 }),
    ];
    const trust = computeTransitiveTrust(edges, 'a', 'd');
    assert.ok(Math.abs(trust - 0.81) < 1e-10);
  });

  it('respects maxDepth limit', () => {
    const edges = [
      createTrustEdge({ from: 'a', to: 'b', category: 'direct', value: 0.9 }),
      createTrustEdge({ from: 'b', to: 'c', category: 'direct', value: 0.9 }),
      createTrustEdge({ from: 'c', to: 'd', category: 'direct', value: 0.9 }),
    ];
    // maxDepth=2 should find a->b->c but not a->b->c->d
    const trust2 = computeTransitiveTrust(edges, 'a', 'd', 2);
    assert.equal(trust2, 0); // path is 3 hops, maxDepth 2 blocks it

    // maxDepth=3 should find it
    const trust3 = computeTransitiveTrust(edges, 'a', 'd', 3);
    assert.ok(trust3 > 0);
    assert.ok(Math.abs(trust3 - 0.729) < 1e-10);
  });

  it('ignores edges with value <= 0 (blocked edges)', () => {
    const edges = [
      createTrustEdge({ from: 'a', to: 'b', category: 'direct', value: 0 }),
      createTrustEdge({ from: 'b', to: 'c', category: 'direct', value: 0.9 }),
    ];
    assert.equal(computeTransitiveTrust(edges, 'a', 'c'), 0);
  });

  it('handles cycles without infinite loop', () => {
    const edges = [
      createTrustEdge({ from: 'a', to: 'b', category: 'direct', value: 0.8 }),
      createTrustEdge({ from: 'b', to: 'a', category: 'direct', value: 0.8 }),
      createTrustEdge({ from: 'b', to: 'c', category: 'direct', value: 0.7 }),
    ];
    const trust = computeTransitiveTrust(edges, 'a', 'c');
    assert.ok(Math.abs(trust - 0.56) < 1e-10);
  });

  it('returns 0 when target is unreachable', () => {
    const edges = [
      createTrustEdge({ from: 'a', to: 'b', category: 'direct', value: 0.9 }),
      createTrustEdge({ from: 'c', to: 'd', category: 'direct', value: 0.9 }),
    ];
    assert.equal(computeTransitiveTrust(edges, 'a', 'd'), 0);
  });

  it('handles direct path being the best even with transitive paths', () => {
    const edges = [
      // Direct: a -> d with 0.95
      createTrustEdge({ from: 'a', to: 'd', category: 'direct', value: 0.95 }),
      // Transitive: a -> b -> d with 0.9 * 0.9 = 0.81
      createTrustEdge({ from: 'a', to: 'b', category: 'direct', value: 0.9 }),
      createTrustEdge({ from: 'b', to: 'd', category: 'direct', value: 0.9 }),
    ];
    const trust = computeTransitiveTrust(edges, 'a', 'd');
    assert.equal(trust, 0.95);
  });

  it('handles maxDepth=1 (direct only)', () => {
    const edges = [
      createTrustEdge({ from: 'a', to: 'b', category: 'direct', value: 0.8 }),
      createTrustEdge({ from: 'b', to: 'c', category: 'direct', value: 0.7 }),
    ];
    assert.equal(computeTransitiveTrust(edges, 'a', 'b', 1), 0.8);
    assert.equal(computeTransitiveTrust(edges, 'a', 'c', 1), 0);
  });
});
