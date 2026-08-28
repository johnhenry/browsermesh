// Run with: node --import ./test/_setup-globals.mjs --test test/marketplace.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  LISTING_PUBLISH,
  LISTING_QUERY,
  LISTING_RESPONSE,
  LISTING_PURCHASE,
  REVIEW_SUBMIT,
  REVIEW_QUERY,
  ServiceListing,
  ServiceReview,
  Marketplace,
  MarketplaceIndex,
} from '../src/marketplace.mjs';

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('LISTING_PUBLISH equals 0xdf', () => {
    assert.equal(LISTING_PUBLISH, 0xdf);
  });

  it('LISTING_QUERY equals 0xe0', () => {
    assert.equal(LISTING_QUERY, 0xe0);
  });

  it('LISTING_RESPONSE equals 0xe1', () => {
    assert.equal(LISTING_RESPONSE, 0xe1);
  });

  it('LISTING_PURCHASE equals 0xe2', () => {
    assert.equal(LISTING_PURCHASE, 0xe2);
  });

  it('REVIEW_SUBMIT equals 0xe3', () => {
    assert.equal(REVIEW_SUBMIT, 0xe3);
  });

  it('REVIEW_QUERY equals 0xe4', () => {
    assert.equal(REVIEW_QUERY, 0xe4);
  });
});

// ---------------------------------------------------------------------------
// ServiceListing
// ---------------------------------------------------------------------------

describe('ServiceListing', () => {
  it('constructor sets all fields', () => {
    const l = new ServiceListing({
      id: 'svc-1',
      name: 'GPT Proxy',
      description: 'Proxy to GPT models',
      providerPodId: 'pod-a',
      category: 'ai',
      pricing: { model: 'per-call', amount: 10, currency: 'credits' },
      tags: ['ai', 'llm'],
      version: '2.0.0',
      endpoint: 'https://example.com/api',
      metadata: { region: 'us-east' },
      publishedAt: 1000,
      expiresAt: 9000,
      status: 'paused',
    });
    assert.equal(l.id, 'svc-1');
    assert.equal(l.name, 'GPT Proxy');
    assert.equal(l.description, 'Proxy to GPT models');
    assert.equal(l.providerPodId, 'pod-a');
    assert.equal(l.category, 'ai');
    assert.deepEqual(l.pricing, { model: 'per-call', amount: 10, currency: 'credits' });
    assert.deepEqual(l.tags, ['ai', 'llm']);
    assert.equal(l.version, '2.0.0');
    assert.equal(l.endpoint, 'https://example.com/api');
    assert.deepEqual(l.metadata, { region: 'us-east' });
    assert.equal(l.publishedAt, 1000);
    assert.equal(l.expiresAt, 9000);
    assert.equal(l.status, 'paused');
  });

  it('applies defaults for omitted fields', () => {
    const l = new ServiceListing({
      id: 'svc-2',
      name: 'Echo',
      description: 'Echo service',
      providerPodId: 'pod-b',
      category: 'utility',
    });
    assert.deepEqual(l.pricing, { model: 'free', amount: 0, currency: 'credits' });
    assert.deepEqual(l.tags, []);
    assert.equal(l.version, '1.0.0');
    assert.equal(l.endpoint, null);
    assert.deepEqual(l.metadata, {});
    assert.equal(typeof l.publishedAt, 'number');
    assert.equal(l.expiresAt, null);
    assert.equal(l.status, 'active');
  });

  it('throws when id is missing', () => {
    assert.throws(
      () => new ServiceListing({ name: 'x', description: 'x', providerPodId: 'p', category: 'c' }),
      /id is required/,
    );
  });

  it('throws when name is missing', () => {
    assert.throws(
      () => new ServiceListing({ id: 'x', description: 'x', providerPodId: 'p', category: 'c' }),
      /name is required/,
    );
  });

  it('throws when providerPodId is missing', () => {
    assert.throws(
      () => new ServiceListing({ id: 'x', name: 'x', description: 'x', category: 'c' }),
      /providerPodId is required/,
    );
  });

  it('throws when category is missing', () => {
    assert.throws(
      () => new ServiceListing({ id: 'x', name: 'x', description: 'x', providerPodId: 'p' }),
      /category is required/,
    );
  });

  it('throws on invalid status', () => {
    assert.throws(
      () => new ServiceListing({
        id: 'x', name: 'x', description: 'x', providerPodId: 'p', category: 'c', status: 'bogus',
      }),
      /invalid status/i,
    );
  });

  it('throws on invalid pricing model', () => {
    assert.throws(
      () => new ServiceListing({
        id: 'x', name: 'x', description: 'x', providerPodId: 'p', category: 'c',
        pricing: { model: 'barter' },
      }),
      /invalid pricing model/i,
    );
  });

  it('copies tags array to avoid external mutation', () => {
    const tags = ['a', 'b'];
    const l = new ServiceListing({
      id: 'x', name: 'x', description: 'x', providerPodId: 'p', category: 'c',
      tags,
    });
    tags.push('c');
    assert.deepEqual(l.tags, ['a', 'b']);
  });

  // -- isExpired ------------------------------------------------------------

  it('isExpired returns false when no expiresAt', () => {
    const l = new ServiceListing({
      id: 'x', name: 'x', description: 'x', providerPodId: 'p', category: 'c',
    });
    assert.ok(!l.isExpired());
  });

  it('isExpired returns false before expiresAt', () => {
    const l = new ServiceListing({
      id: 'x', name: 'x', description: 'x', providerPodId: 'p', category: 'c',
      expiresAt: Date.now() + 100_000,
    });
    assert.ok(!l.isExpired());
  });

  it('isExpired returns true past expiresAt', () => {
    const l = new ServiceListing({
      id: 'x', name: 'x', description: 'x', providerPodId: 'p', category: 'c',
      expiresAt: 1000,
    });
    assert.ok(l.isExpired());
  });

  // -- matchesQuery ---------------------------------------------------------

  it('matchesQuery matches on name', () => {
    const l = new ServiceListing({
      id: 'x', name: 'GPT Proxy Service', description: 'desc', providerPodId: 'p', category: 'c',
    });
    assert.ok(l.matchesQuery('gpt'));
    assert.ok(l.matchesQuery('proxy'));
    assert.ok(!l.matchesQuery('llama'));
  });

  it('matchesQuery matches on description', () => {
    const l = new ServiceListing({
      id: 'x', name: 'Svc', description: 'Machine learning inference', providerPodId: 'p', category: 'c',
    });
    assert.ok(l.matchesQuery('machine'));
    assert.ok(l.matchesQuery('inference'));
  });

  it('matchesQuery matches on tags', () => {
    const l = new ServiceListing({
      id: 'x', name: 'Svc', description: 'desc', providerPodId: 'p', category: 'c',
      tags: ['ai', 'gpu-compute'],
    });
    assert.ok(l.matchesQuery('gpu'));
    assert.ok(!l.matchesQuery('cpu'));
  });

  it('matchesQuery is case insensitive', () => {
    const l = new ServiceListing({
      id: 'x', name: 'GPT Proxy', description: 'desc', providerPodId: 'p', category: 'c',
    });
    assert.ok(l.matchesQuery('gpt'));
    assert.ok(l.matchesQuery('GPT'));
    assert.ok(l.matchesQuery('Gpt'));
  });

  it('matchesQuery returns true for empty query', () => {
    const l = new ServiceListing({
      id: 'x', name: 'Svc', description: 'desc', providerPodId: 'p', category: 'c',
    });
    assert.ok(l.matchesQuery(''));
  });

  // -- toJSON / fromJSON ----------------------------------------------------

  it('round-trips via JSON', () => {
    const l = new ServiceListing({
      id: 'rt1',
      name: 'RT Service',
      description: 'Round trip test',
      providerPodId: 'pod-a',
      category: 'test',
      pricing: { model: 'subscription', amount: 100, currency: 'credits' },
      tags: ['test', 'rt'],
      version: '3.0.0',
      endpoint: '/api/rt',
      metadata: { key: 'val' },
      publishedAt: 5000,
      expiresAt: 99000,
      status: 'active',
    });
    const l2 = ServiceListing.fromJSON(l.toJSON());
    assert.deepEqual(l2.toJSON(), l.toJSON());
    assert.ok(l2 instanceof ServiceListing);
  });

  it('toJSON returns copy of tags', () => {
    const l = new ServiceListing({
      id: 'x', name: 'x', description: 'x', providerPodId: 'p', category: 'c',
      tags: ['a'],
    });
    const json = l.toJSON();
    json.tags.push('b');
    assert.deepEqual(l.tags, ['a']);
  });
});

// ---------------------------------------------------------------------------
// ServiceReview
// ---------------------------------------------------------------------------

describe('ServiceReview', () => {
  it('constructor sets all fields', () => {
    const r = new ServiceReview({
      id: 'rev-1',
      listingId: 'svc-1',
      reviewerPodId: 'pod-b',
      rating: 4,
      comment: 'Great service',
      createdAt: 2000,
    });
    assert.equal(r.id, 'rev-1');
    assert.equal(r.listingId, 'svc-1');
    assert.equal(r.reviewerPodId, 'pod-b');
    assert.equal(r.rating, 4);
    assert.equal(r.comment, 'Great service');
    assert.equal(r.createdAt, 2000);
  });

  it('applies defaults for omitted fields', () => {
    const r = new ServiceReview({
      id: 'rev-2',
      listingId: 'svc-1',
      reviewerPodId: 'pod-c',
      rating: 3,
    });
    assert.equal(r.comment, null);
    assert.equal(typeof r.createdAt, 'number');
  });

  it('throws when id is missing', () => {
    assert.throws(
      () => new ServiceReview({ listingId: 'x', reviewerPodId: 'p', rating: 3 }),
      /id is required/,
    );
  });

  it('throws when listingId is missing', () => {
    assert.throws(
      () => new ServiceReview({ id: 'x', reviewerPodId: 'p', rating: 3 }),
      /listingId is required/,
    );
  });

  it('throws when reviewerPodId is missing', () => {
    assert.throws(
      () => new ServiceReview({ id: 'x', listingId: 'l', rating: 3 }),
      /reviewerPodId is required/,
    );
  });

  it('throws when rating is missing', () => {
    assert.throws(
      () => new ServiceReview({ id: 'x', listingId: 'l', reviewerPodId: 'p' }),
      /rating is required/,
    );
  });

  it('throws when rating is below 1', () => {
    assert.throws(
      () => new ServiceReview({ id: 'x', listingId: 'l', reviewerPodId: 'p', rating: 0 }),
      /rating must be.*1.*5/i,
    );
  });

  it('throws when rating is above 5', () => {
    assert.throws(
      () => new ServiceReview({ id: 'x', listingId: 'l', reviewerPodId: 'p', rating: 6 }),
      /rating must be.*1.*5/i,
    );
  });

  it('throws when rating is not an integer', () => {
    assert.throws(
      () => new ServiceReview({ id: 'x', listingId: 'l', reviewerPodId: 'p', rating: 3.5 }),
      /rating must be.*integer/i,
    );
  });

  it('accepts rating of 1', () => {
    const r = new ServiceReview({ id: 'x', listingId: 'l', reviewerPodId: 'p', rating: 1 });
    assert.equal(r.rating, 1);
  });

  it('accepts rating of 5', () => {
    const r = new ServiceReview({ id: 'x', listingId: 'l', reviewerPodId: 'p', rating: 5 });
    assert.equal(r.rating, 5);
  });

  // -- toJSON / fromJSON ----------------------------------------------------

  it('round-trips via JSON', () => {
    const r = new ServiceReview({
      id: 'rt-rev',
      listingId: 'svc-1',
      reviewerPodId: 'pod-b',
      rating: 4,
      comment: 'Very good',
      createdAt: 3000,
    });
    const r2 = ServiceReview.fromJSON(r.toJSON());
    assert.deepEqual(r2.toJSON(), r.toJSON());
    assert.ok(r2 instanceof ServiceReview);
  });
});

// ---------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------

describe('Marketplace', () => {
  let mp;

  const makeListing = (overrides = {}) =>
    new ServiceListing({
      id: overrides.id || `svc-${Math.random().toString(36).slice(2, 6)}`,
      name: overrides.name || 'Test Service',
      description: overrides.description || 'A test service',
      providerPodId: overrides.providerPodId || 'pod-a',
      category: overrides.category || 'general',
      ...overrides,
    });

  const makeReview = (overrides = {}) =>
    new ServiceReview({
      id: overrides.id || `rev-${Math.random().toString(36).slice(2, 6)}`,
      listingId: overrides.listingId || 'svc-1',
      reviewerPodId: overrides.reviewerPodId || 'pod-b',
      rating: overrides.rating || 4,
      ...overrides,
    });

  beforeEach(() => {
    mp = new Marketplace({ localPodId: 'local-pod' });
  });

  // -- constructor ----------------------------------------------------------

  it('constructor sets localPodId', () => {
    assert.equal(mp.localPodId, 'local-pod');
  });

  it('constructor throws when localPodId is missing', () => {
    assert.throws(() => new Marketplace({}), /localPodId is required/);
  });

  // -- publish --------------------------------------------------------------

  it('publish adds listing and returns id', () => {
    const l = makeListing({ id: 'pub-1' });
    const id = mp.publish(l);
    assert.equal(id, 'pub-1');
  });

  it('publish rejects duplicate ids', () => {
    mp.publish(makeListing({ id: 'dup' }));
    assert.throws(() => mp.publish(makeListing({ id: 'dup' })), /already exists/);
  });

  // -- unpublish ------------------------------------------------------------

  it('unpublish removes listing if owner', () => {
    mp.publish(makeListing({ id: 'u1', providerPodId: 'local-pod' }));
    assert.ok(mp.unpublish('u1'));
    assert.equal(mp.getListingById('u1'), null);
  });

  it('unpublish throws if not owner', () => {
    mp.publish(makeListing({ id: 'u2', providerPodId: 'other-pod' }));
    assert.throws(() => mp.unpublish('u2'), /not the owner/i);
  });

  it('unpublish returns false for unknown id', () => {
    assert.ok(!mp.unpublish('nope'));
  });

  // -- update ---------------------------------------------------------------

  it('update modifies listing fields', () => {
    mp.publish(makeListing({ id: 'upd1', name: 'Old', providerPodId: 'local-pod' }));
    mp.update('upd1', { name: 'New', description: 'Updated desc' });
    const l = mp.getListingById('upd1');
    assert.equal(l.name, 'New');
    assert.equal(l.description, 'Updated desc');
  });

  it('update throws if not owner', () => {
    mp.publish(makeListing({ id: 'upd2', providerPodId: 'other-pod' }));
    assert.throws(() => mp.update('upd2', { name: 'Hacked' }), /not the owner/i);
  });

  it('update throws for unknown id', () => {
    assert.throws(() => mp.update('nope', { name: 'x' }), /not found/i);
  });

  // -- getListingById -------------------------------------------------------

  it('getListingById returns listing', () => {
    mp.publish(makeListing({ id: 'g1', name: 'Test' }));
    const l = mp.getListingById('g1');
    assert.equal(l.name, 'Test');
  });

  it('getListingById returns null for unknown', () => {
    assert.equal(mp.getListingById('nope'), null);
  });

  // -- getListingsByProvider ------------------------------------------------

  it('getListingsByProvider returns listings for a pod', () => {
    mp.publish(makeListing({ id: 'p1', providerPodId: 'pod-x' }));
    mp.publish(makeListing({ id: 'p2', providerPodId: 'pod-x' }));
    mp.publish(makeListing({ id: 'p3', providerPodId: 'pod-y' }));
    assert.equal(mp.getListingsByProvider('pod-x').length, 2);
    assert.equal(mp.getListingsByProvider('pod-y').length, 1);
    assert.equal(mp.getListingsByProvider('pod-z').length, 0);
  });

  // -- search ---------------------------------------------------------------

  it('search by text matches name/description/tags', () => {
    mp.publish(makeListing({ id: 's1', name: 'GPT Proxy', description: 'AI proxy', tags: ['ai'] }));
    mp.publish(makeListing({ id: 's2', name: 'Storage', description: 'File storage' }));

    const results = mp.search({ text: 'gpt' });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 's1');
  });

  it('search by category', () => {
    mp.publish(makeListing({ id: 's1', category: 'ai' }));
    mp.publish(makeListing({ id: 's2', category: 'storage' }));
    assert.equal(mp.search({ category: 'ai' }).length, 1);
  });

  it('search by tags', () => {
    mp.publish(makeListing({ id: 's1', tags: ['gpu', 'fast'] }));
    mp.publish(makeListing({ id: 's2', tags: ['cpu'] }));
    assert.equal(mp.search({ tags: ['gpu'] }).length, 1);
  });

  it('search by price range', () => {
    mp.publish(makeListing({ id: 's1', pricing: { model: 'per-call', amount: 5, currency: 'credits' } }));
    mp.publish(makeListing({ id: 's2', pricing: { model: 'per-call', amount: 50, currency: 'credits' } }));
    mp.publish(makeListing({ id: 's3', pricing: { model: 'free', amount: 0, currency: 'credits' } }));
    assert.equal(mp.search({ maxPrice: 10 }).length, 2);
    assert.equal(mp.search({ minPrice: 10 }).length, 1);
  });

  it('search by minRating', () => {
    mp.publish(makeListing({ id: 'r1', providerPodId: 'pod-x' }));
    mp.publish(makeListing({ id: 'r2', providerPodId: 'pod-y' }));
    mp.addReview(makeReview({ id: 'rev1', listingId: 'r1', reviewerPodId: 'pod-z', rating: 5 }));
    mp.addReview(makeReview({ id: 'rev2', listingId: 'r2', reviewerPodId: 'pod-z', rating: 2 }));
    assert.equal(mp.search({ minRating: 4 }).length, 1);
  });

  it('search with no criteria returns all active', () => {
    mp.publish(makeListing({ id: 's1' }));
    mp.publish(makeListing({ id: 's2' }));
    assert.equal(mp.search({}).length, 2);
  });

  it('search excludes non-active listings', () => {
    mp.publish(makeListing({ id: 's1', providerPodId: 'local-pod' }));
    mp.update('s1', { status: 'paused' });
    assert.equal(mp.search({}).length, 0);
  });

  it('search combines multiple criteria', () => {
    mp.publish(makeListing({
      id: 'combo',
      name: 'AI Service',
      category: 'ai',
      tags: ['gpu'],
      pricing: { model: 'per-call', amount: 5, currency: 'credits' },
    }));
    mp.publish(makeListing({
      id: 'other',
      name: 'Other Service',
      category: 'storage',
    }));
    const results = mp.search({ text: 'ai', category: 'ai', tags: ['gpu'], maxPrice: 10 });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'combo');
  });

  // -- addReview ------------------------------------------------------------

  it('addReview adds a review', () => {
    mp.publish(makeListing({ id: 'svc-1', providerPodId: 'pod-x' }));
    const r = makeReview({ id: 'rev1', listingId: 'svc-1', reviewerPodId: 'pod-y' });
    mp.addReview(r);
    assert.equal(mp.getReviews('svc-1').length, 1);
  });

  it('addReview prevents self-review', () => {
    mp.publish(makeListing({ id: 'svc-1', providerPodId: 'pod-x' }));
    const r = makeReview({ id: 'rev1', listingId: 'svc-1', reviewerPodId: 'pod-x' });
    assert.throws(() => mp.addReview(r), /self-review/i);
  });

  it('addReview throws for unknown listing', () => {
    const r = makeReview({ id: 'rev1', listingId: 'nope' });
    assert.throws(() => mp.addReview(r), /listing not found/i);
  });

  it('addReview rejects duplicate review ids', () => {
    mp.publish(makeListing({ id: 'svc-1', providerPodId: 'pod-x' }));
    mp.addReview(makeReview({ id: 'dup', listingId: 'svc-1', reviewerPodId: 'pod-y' }));
    assert.throws(
      () => mp.addReview(makeReview({ id: 'dup', listingId: 'svc-1', reviewerPodId: 'pod-z' })),
      /already exists/,
    );
  });

  // -- getReviews -----------------------------------------------------------

  it('getReviews returns all reviews for a listing', () => {
    mp.publish(makeListing({ id: 'svc-1', providerPodId: 'pod-x' }));
    mp.addReview(makeReview({ id: 'r1', listingId: 'svc-1', reviewerPodId: 'pod-y', rating: 5 }));
    mp.addReview(makeReview({ id: 'r2', listingId: 'svc-1', reviewerPodId: 'pod-z', rating: 3 }));
    assert.equal(mp.getReviews('svc-1').length, 2);
  });

  it('getReviews returns empty array for no reviews', () => {
    assert.deepEqual(mp.getReviews('nope'), []);
  });

  // -- getAverageRating -----------------------------------------------------

  it('getAverageRating computes average', () => {
    mp.publish(makeListing({ id: 'svc-1', providerPodId: 'pod-x' }));
    mp.addReview(makeReview({ id: 'r1', listingId: 'svc-1', reviewerPodId: 'pod-y', rating: 5 }));
    mp.addReview(makeReview({ id: 'r2', listingId: 'svc-1', reviewerPodId: 'pod-z', rating: 3 }));
    assert.equal(mp.getAverageRating('svc-1'), 4);
  });

  it('getAverageRating returns 0 for no reviews', () => {
    assert.equal(mp.getAverageRating('nope'), 0);
  });

  it('getAverageRating handles single review', () => {
    mp.publish(makeListing({ id: 'svc-1', providerPodId: 'pod-x' }));
    mp.addReview(makeReview({ id: 'r1', listingId: 'svc-1', reviewerPodId: 'pod-y', rating: 4 }));
    assert.equal(mp.getAverageRating('svc-1'), 4);
  });

  // -- getCategories --------------------------------------------------------

  it('getCategories returns distinct categories', () => {
    mp.publish(makeListing({ id: 's1', category: 'ai' }));
    mp.publish(makeListing({ id: 's2', category: 'storage' }));
    mp.publish(makeListing({ id: 's3', category: 'ai' }));
    const cats = mp.getCategories();
    assert.equal(cats.length, 2);
    assert.ok(cats.includes('ai'));
    assert.ok(cats.includes('storage'));
  });

  it('getCategories returns empty array when no listings', () => {
    assert.deepEqual(mp.getCategories(), []);
  });

  // -- getFeatured ----------------------------------------------------------

  it('getFeatured returns top-rated active listings', () => {
    mp.publish(makeListing({ id: 's1', name: 'Low', providerPodId: 'pod-x' }));
    mp.publish(makeListing({ id: 's2', name: 'High', providerPodId: 'pod-y' }));
    mp.addReview(makeReview({ id: 'r1', listingId: 's1', reviewerPodId: 'pod-z', rating: 2 }));
    mp.addReview(makeReview({ id: 'r2', listingId: 's2', reviewerPodId: 'pod-z', rating: 5 }));
    const featured = mp.getFeatured(1);
    assert.equal(featured.length, 1);
    assert.equal(featured[0].id, 's2');
  });

  it('getFeatured defaults to 10 listings', () => {
    for (let i = 0; i < 15; i++) {
      mp.publish(makeListing({ id: `s${i}`, providerPodId: `pod-${i}` }));
      mp.addReview(makeReview({
        id: `r${i}`, listingId: `s${i}`, reviewerPodId: 'pod-reviewer', rating: 5,
      }));
    }
    assert.equal(mp.getFeatured().length, 10);
  });

  it('getFeatured excludes non-active listings', () => {
    mp.publish(makeListing({ id: 's1', providerPodId: 'local-pod' }));
    mp.addReview(makeReview({ id: 'r1', listingId: 's1', reviewerPodId: 'pod-z', rating: 5 }));
    mp.update('s1', { status: 'paused' });
    assert.equal(mp.getFeatured().length, 0);
  });

  // -- callbacks ------------------------------------------------------------

  it('onPublish fires when listing is published', () => {
    let fired = null;
    mp.onPublish((listing) => { fired = listing; });
    const l = makeListing({ id: 'cb1' });
    mp.publish(l);
    assert.equal(fired.id, 'cb1');
  });

  it('onUnpublish fires when listing is unpublished', () => {
    let fired = null;
    mp.onUnpublish((listingId) => { fired = listingId; });
    mp.publish(makeListing({ id: 'cb2', providerPodId: 'local-pod' }));
    mp.unpublish('cb2');
    assert.equal(fired, 'cb2');
  });

  it('onReview fires when review is added', () => {
    let fired = null;
    mp.onReview((review) => { fired = review; });
    mp.publish(makeListing({ id: 'svc-1', providerPodId: 'pod-x' }));
    mp.addReview(makeReview({ id: 'rcb', listingId: 'svc-1', reviewerPodId: 'pod-y' }));
    assert.equal(fired.id, 'rcb');
  });

  // -- getStats -------------------------------------------------------------

  it('getStats returns correct counts', () => {
    mp.publish(makeListing({ id: 's1', providerPodId: 'pod-x' }));
    mp.publish(makeListing({ id: 's2', providerPodId: 'local-pod' }));
    mp.update('s2', { status: 'paused' });
    mp.addReview(makeReview({ id: 'r1', listingId: 's1', reviewerPodId: 'pod-y', rating: 4 }));
    mp.addReview(makeReview({ id: 'r2', listingId: 's1', reviewerPodId: 'pod-z', rating: 2 }));

    const stats = mp.getStats();
    assert.equal(stats.totalListings, 2);
    assert.equal(stats.activeListings, 1);
    assert.equal(stats.totalReviews, 2);
    assert.equal(stats.avgRating, 3);
  });

  it('getStats returns zeros when empty', () => {
    const stats = mp.getStats();
    assert.equal(stats.totalListings, 0);
    assert.equal(stats.activeListings, 0);
    assert.equal(stats.totalReviews, 0);
    assert.equal(stats.avgRating, 0);
  });

  // -- toJSON / fromJSON ----------------------------------------------------

  it('round-trips via JSON', () => {
    mp.publish(makeListing({ id: 'rt1', name: 'Svc A', providerPodId: 'pod-x', category: 'ai' }));
    mp.publish(makeListing({ id: 'rt2', name: 'Svc B', providerPodId: 'pod-y', category: 'storage' }));
    mp.addReview(makeReview({ id: 'rrt1', listingId: 'rt1', reviewerPodId: 'pod-z', rating: 5 }));

    const json = mp.toJSON();
    const mp2 = Marketplace.fromJSON(json);
    assert.equal(mp2.getListingById('rt1').name, 'Svc A');
    assert.equal(mp2.getListingById('rt2').name, 'Svc B');
    assert.equal(mp2.getReviews('rt1').length, 1);
    assert.equal(mp2.getStats().totalListings, 2);
  });
});

// ---------------------------------------------------------------------------
// MarketplaceIndex
// ---------------------------------------------------------------------------

describe('MarketplaceIndex', () => {
  let idx;

  const makeListing = (overrides = {}) =>
    new ServiceListing({
      id: overrides.id || `svc-${Math.random().toString(36).slice(2, 6)}`,
      name: overrides.name || 'Test Service',
      description: overrides.description || 'A test service',
      providerPodId: overrides.providerPodId || 'pod-a',
      category: overrides.category || 'general',
      ...overrides,
    });

  beforeEach(() => {
    idx = new MarketplaceIndex();
  });

  // -- addListing / removeListing -------------------------------------------

  it('addListing indexes by category', () => {
    idx.addListing(makeListing({ id: 's1', category: 'ai' }));
    idx.addListing(makeListing({ id: 's2', category: 'ai' }));
    idx.addListing(makeListing({ id: 's3', category: 'storage' }));
    assert.equal(idx.queryByCategory('ai').length, 2);
  });

  it('addListing indexes by tags', () => {
    idx.addListing(makeListing({ id: 's1', tags: ['gpu', 'fast'] }));
    idx.addListing(makeListing({ id: 's2', tags: ['gpu'] }));
    assert.equal(idx.queryByTag('gpu').length, 2);
    assert.equal(idx.queryByTag('fast').length, 1);
  });

  it('addListing indexes by provider', () => {
    idx.addListing(makeListing({ id: 's1', providerPodId: 'pod-a' }));
    idx.addListing(makeListing({ id: 's2', providerPodId: 'pod-a' }));
    assert.equal(idx.queryByProvider('pod-a').length, 2);
  });

  it('removeListing cleans up all indexes', () => {
    const l = makeListing({ id: 's1', category: 'ai', tags: ['gpu'], providerPodId: 'pod-a' });
    idx.addListing(l);
    idx.removeListing('s1');
    assert.equal(idx.queryByCategory('ai').length, 0);
    assert.equal(idx.queryByTag('gpu').length, 0);
    assert.equal(idx.queryByProvider('pod-a').length, 0);
  });

  it('removeListing is safe for unknown id', () => {
    idx.removeListing('nope'); // should not throw
  });

  // -- queryByCategory ------------------------------------------------------

  it('queryByCategory returns empty for unknown category', () => {
    assert.deepEqual(idx.queryByCategory('nope'), []);
  });

  // -- queryByTag -----------------------------------------------------------

  it('queryByTag returns empty for unknown tag', () => {
    assert.deepEqual(idx.queryByTag('nope'), []);
  });

  // -- queryByProvider ------------------------------------------------------

  it('queryByProvider returns empty for unknown provider', () => {
    assert.deepEqual(idx.queryByProvider('nope'), []);
  });

  // -- fullTextSearch -------------------------------------------------------

  it('fullTextSearch searches name', () => {
    idx.addListing(makeListing({ id: 's1', name: 'GPT Proxy Service' }));
    idx.addListing(makeListing({ id: 's2', name: 'Storage API' }));
    assert.equal(idx.fullTextSearch('gpt').length, 1);
    assert.equal(idx.fullTextSearch('gpt')[0], 's1');
  });

  it('fullTextSearch searches description', () => {
    idx.addListing(makeListing({ id: 's1', description: 'Machine learning inference' }));
    assert.equal(idx.fullTextSearch('inference').length, 1);
  });

  it('fullTextSearch searches tags', () => {
    idx.addListing(makeListing({ id: 's1', tags: ['ai-compute'] }));
    assert.equal(idx.fullTextSearch('ai-compute').length, 1);
  });

  it('fullTextSearch is case insensitive', () => {
    idx.addListing(makeListing({ id: 's1', name: 'GPT Service' }));
    assert.equal(idx.fullTextSearch('gpt').length, 1);
    assert.equal(idx.fullTextSearch('GPT').length, 1);
  });

  it('fullTextSearch returns empty for no match', () => {
    idx.addListing(makeListing({ id: 's1', name: 'Echo' }));
    assert.deepEqual(idx.fullTextSearch('quantum'), []);
  });

  it('fullTextSearch returns empty for empty query', () => {
    idx.addListing(makeListing({ id: 's1' }));
    assert.deepEqual(idx.fullTextSearch(''), []);
  });

  it('fullTextSearch handles removed listings', () => {
    idx.addListing(makeListing({ id: 's1', name: 'GPT' }));
    idx.removeListing('s1');
    assert.deepEqual(idx.fullTextSearch('gpt'), []);
  });

  it('fullTextSearch does not return duplicates', () => {
    // Name and description both match
    idx.addListing(makeListing({ id: 's1', name: 'GPU Compute', description: 'GPU-accelerated compute service', tags: ['gpu'] }));
    const results = idx.fullTextSearch('gpu');
    assert.equal(results.length, 1);
  });
});
