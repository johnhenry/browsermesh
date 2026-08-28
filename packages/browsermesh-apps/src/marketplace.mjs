/**
 * clawser-mesh-marketplace.js -- Service marketplace for BrowserMesh.
 *
 * Publish, discover, and review services offered by mesh peers. Includes
 * text search, category/tag filtering, rating aggregation, and an efficient
 * inverted index for O(1) lookups.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-marketplace.test.mjs
 */

import { MESH_TYPE } from '@johnhenry/browsermesh-primitives';

// ---------------------------------------------------------------------------
// Wire constants (re-exported from canonical registry)
// ---------------------------------------------------------------------------

export const LISTING_PUBLISH = MESH_TYPE.LISTING_PUBLISH;    // 0xdf
export const LISTING_QUERY = MESH_TYPE.LISTING_QUERY;        // 0xe0
export const LISTING_RESPONSE = MESH_TYPE.LISTING_RESPONSE;  // 0xe1
export const LISTING_PURCHASE = MESH_TYPE.LISTING_PURCHASE;  // 0xe2
export const REVIEW_SUBMIT = MESH_TYPE.REVIEW_SUBMIT;        // 0xe3
export const REVIEW_QUERY = MESH_TYPE.REVIEW_QUERY;          // 0xe4

// ---------------------------------------------------------------------------
// Valid enumerations
// ---------------------------------------------------------------------------

const VALID_STATUSES = Object.freeze([
  'active', 'paused', 'expired', 'removed',
]);

const VALID_PRICING_MODELS = Object.freeze([
  'free', 'per-call', 'subscription', 'credits',
]);

// ---------------------------------------------------------------------------
// ServiceListing
// ---------------------------------------------------------------------------

/**
 * A service offered on the marketplace.
 */
export class ServiceListing {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.name
   * @param {string} opts.description
   * @param {string} opts.providerPodId
   * @param {string} opts.category
   * @param {object} [opts.pricing]
   * @param {string} [opts.pricing.model='free']
   * @param {number} [opts.pricing.amount=0]
   * @param {string} [opts.pricing.currency='credits']
   * @param {string[]} [opts.tags=[]]
   * @param {string} [opts.version='1.0.0']
   * @param {string|null} [opts.endpoint=null]
   * @param {object} [opts.metadata={}]
   * @param {number} [opts.publishedAt]
   * @param {number|null} [opts.expiresAt=null]
   * @param {string} [opts.status='active']
   */
  constructor({
    id,
    name,
    description,
    providerPodId,
    category,
    pricing = {},
    tags = [],
    version = '1.0.0',
    endpoint,
    metadata = {},
    publishedAt,
    expiresAt,
    status = 'active',
  }) {
    if (!id || typeof id !== 'string') {
      throw new Error('id is required and must be a non-empty string');
    }
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a non-empty string');
    }
    if (!providerPodId || typeof providerPodId !== 'string') {
      throw new Error('providerPodId is required and must be a non-empty string');
    }
    if (!category || typeof category !== 'string') {
      throw new Error('category is required and must be a non-empty string');
    }
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid status: "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`);
    }

    // Validate pricing model
    const pricingModel = pricing.model ?? 'free';
    if (!VALID_PRICING_MODELS.includes(pricingModel)) {
      throw new Error(`Invalid pricing model: "${pricingModel}". Must be one of: ${VALID_PRICING_MODELS.join(', ')}`);
    }

    this.id = id;
    this.name = name;
    this.description = description ?? '';
    this.providerPodId = providerPodId;
    this.category = category;
    this.pricing = {
      model: pricingModel,
      amount: pricing.amount ?? 0,
      currency: pricing.currency ?? 'credits',
    };
    this.tags = [...tags];
    this.version = version;
    this.endpoint = endpoint ?? null;
    this.metadata = metadata ? { ...metadata } : {};
    this.publishedAt = publishedAt ?? Date.now();
    this.expiresAt = expiresAt ?? null;
    this.status = status;
  }

  /**
   * Whether the listing has passed its expiration date.
   * @param {number} [now]
   * @returns {boolean}
   */
  isExpired(now = Date.now()) {
    if (this.expiresAt === null || this.expiresAt === undefined) return false;
    return now > this.expiresAt;
  }

  /**
   * Check if the listing matches a text query (searches name, description, tags).
   * @param {string} query
   * @returns {boolean}
   */
  matchesQuery(query) {
    if (!query || query.length === 0) return true;
    const q = query.toLowerCase();
    if (this.name.toLowerCase().includes(q)) return true;
    if (this.description.toLowerCase().includes(q)) return true;
    for (const tag of this.tags) {
      if (tag.toLowerCase().includes(q)) return true;
    }
    return false;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      providerPodId: this.providerPodId,
      category: this.category,
      pricing: { ...this.pricing },
      tags: [...this.tags],
      version: this.version,
      endpoint: this.endpoint,
      metadata: { ...this.metadata },
      publishedAt: this.publishedAt,
      expiresAt: this.expiresAt,
      status: this.status,
    };
  }

  /**
   * @param {object} data
   * @returns {ServiceListing}
   */
  static fromJSON(data) {
    return new ServiceListing({
      id: data.id,
      name: data.name,
      description: data.description,
      providerPodId: data.providerPodId,
      category: data.category,
      pricing: data.pricing,
      tags: data.tags,
      version: data.version,
      endpoint: data.endpoint,
      metadata: data.metadata,
      publishedAt: data.publishedAt,
      expiresAt: data.expiresAt,
      status: data.status,
    });
  }
}

// ---------------------------------------------------------------------------
// ServiceReview
// ---------------------------------------------------------------------------

/**
 * A review/rating for a marketplace service.
 */
export class ServiceReview {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.listingId
   * @param {string} opts.reviewerPodId
   * @param {number} opts.rating - 1-5 integer
   * @param {string|null} [opts.comment=null]
   * @param {number} [opts.createdAt]
   */
  constructor({ id, listingId, reviewerPodId, rating, comment, createdAt }) {
    if (!id || typeof id !== 'string') {
      throw new Error('id is required and must be a non-empty string');
    }
    if (!listingId || typeof listingId !== 'string') {
      throw new Error('listingId is required and must be a non-empty string');
    }
    if (!reviewerPodId || typeof reviewerPodId !== 'string') {
      throw new Error('reviewerPodId is required and must be a non-empty string');
    }
    if (rating === undefined || rating === null) {
      throw new Error('rating is required');
    }
    if (!Number.isInteger(rating)) {
      throw new Error('rating must be an integer between 1 and 5');
    }
    if (rating < 1 || rating > 5) {
      throw new Error('rating must be between 1 and 5');
    }

    this.id = id;
    this.listingId = listingId;
    this.reviewerPodId = reviewerPodId;
    this.rating = rating;
    this.comment = comment ?? null;
    this.createdAt = createdAt ?? Date.now();
  }

  toJSON() {
    return {
      id: this.id,
      listingId: this.listingId,
      reviewerPodId: this.reviewerPodId,
      rating: this.rating,
      comment: this.comment,
      createdAt: this.createdAt,
    };
  }

  /**
   * @param {object} data
   * @returns {ServiceReview}
   */
  static fromJSON(data) {
    return new ServiceReview({
      id: data.id,
      listingId: data.listingId,
      reviewerPodId: data.reviewerPodId,
      rating: data.rating,
      comment: data.comment,
      createdAt: data.createdAt,
    });
  }
}

// ---------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------

/**
 * Service marketplace manager.
 */
export class Marketplace {
  /** @type {string} */
  #localPodId;
  /** @type {Map<string, ServiceListing>} */
  #listings = new Map();
  /** @type {Map<string, ServiceReview[]>} listingId -> reviews */
  #reviews = new Map();
  /** @type {Set<string>} review IDs for duplicate detection */
  #reviewIds = new Set();
  /** @type {MarketplaceIndex} */
  #index = new MarketplaceIndex();

  // Callbacks
  #onPublish = [];
  #onUnpublish = [];
  #onReview = [];

  /**
   * @param {object} opts
   * @param {string} opts.localPodId
   */
  constructor({ localPodId } = {}) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string');
    }
    this.#localPodId = localPodId;
  }

  /** @returns {string} */
  get localPodId() {
    return this.#localPodId;
  }

  // -- Listing lifecycle ----------------------------------------------------

  /**
   * Publish a service listing.
   * @param {ServiceListing} listing
   * @returns {string} listing ID
   */
  publish(listing) {
    if (this.#listings.has(listing.id)) {
      throw new Error(`Listing "${listing.id}" already exists`);
    }
    this.#listings.set(listing.id, listing);
    this.#index.addListing(listing);
    for (const cb of this.#onPublish) cb(listing);
    return listing.id;
  }

  /**
   * Remove a listing (only if owner).
   * @param {string} listingId
   * @returns {boolean}
   */
  unpublish(listingId) {
    const listing = this.#listings.get(listingId);
    if (!listing) return false;
    if (listing.providerPodId !== this.#localPodId) {
      throw new Error('Not the owner of this listing');
    }
    this.#listings.delete(listingId);
    this.#index.removeListing(listingId);
    for (const cb of this.#onUnpublish) cb(listingId);
    return true;
  }

  /**
   * Update a listing (only if owner).
   * @param {string} listingId
   * @param {object} updates
   */
  update(listingId, updates) {
    const listing = this.#listings.get(listingId);
    if (!listing) throw new Error(`Listing "${listingId}" not found`);
    if (listing.providerPodId !== this.#localPodId) {
      throw new Error('Not the owner of this listing');
    }

    // Remove from index before update
    this.#index.removeListing(listingId);

    // Apply updates
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'id') continue; // Cannot change ID
      listing[key] = value;
    }

    // Re-index
    this.#index.addListing(listing);
  }

  // -- Query ----------------------------------------------------------------

  /**
   * Search listings with multiple criteria.
   * @param {object} query
   * @param {string} [query.text]
   * @param {string} [query.category]
   * @param {string[]} [query.tags]
   * @param {number} [query.minPrice]
   * @param {number} [query.maxPrice]
   * @param {number} [query.minRating]
   * @returns {ServiceListing[]}
   */
  search(query = {}) {
    let results = [];

    for (const listing of this.#listings.values()) {
      // Only active listings
      if (listing.status !== 'active') continue;

      // Text search
      if (query.text && !listing.matchesQuery(query.text)) continue;

      // Category
      if (query.category && listing.category !== query.category) continue;

      // Tags
      if (query.tags && query.tags.length > 0) {
        const hasAllTags = query.tags.every(t => listing.tags.includes(t));
        if (!hasAllTags) continue;
      }

      // Price range
      if (query.minPrice !== undefined && listing.pricing.amount < query.minPrice) continue;
      if (query.maxPrice !== undefined && listing.pricing.amount > query.maxPrice) continue;

      // Minimum rating
      if (query.minRating !== undefined) {
        const avg = this.getAverageRating(listing.id);
        if (avg < query.minRating) continue;
      }

      results.push(listing);
    }

    return results;
  }

  /**
   * Get a listing by ID.
   * @param {string} id
   * @returns {ServiceListing|null}
   */
  getListingById(id) {
    return this.#listings.get(id) ?? null;
  }

  /**
   * Get all listings by a specific provider.
   * @param {string} podId
   * @returns {ServiceListing[]}
   */
  getListingsByProvider(podId) {
    const results = [];
    for (const listing of this.#listings.values()) {
      if (listing.providerPodId === podId) results.push(listing);
    }
    return results;
  }

  // -- Reviews --------------------------------------------------------------

  /**
   * Add a review for a listing.
   * @param {ServiceReview} review
   */
  addReview(review) {
    // Check listing exists
    const listing = this.#listings.get(review.listingId);
    if (!listing) throw new Error('Listing not found');

    // Prevent self-review
    if (review.reviewerPodId === listing.providerPodId) {
      throw new Error('Self-review is not allowed');
    }

    // Check for duplicate review ID
    if (this.#reviewIds.has(review.id)) {
      throw new Error(`Review "${review.id}" already exists`);
    }

    if (!this.#reviews.has(review.listingId)) {
      this.#reviews.set(review.listingId, []);
    }
    this.#reviews.get(review.listingId).push(review);
    this.#reviewIds.add(review.id);

    for (const cb of this.#onReview) cb(review);
  }

  /**
   * Get all reviews for a listing.
   * @param {string} listingId
   * @returns {ServiceReview[]}
   */
  getReviews(listingId) {
    return this.#reviews.get(listingId) ?? [];
  }

  /**
   * Calculate the average rating for a listing.
   * @param {string} listingId
   * @returns {number} 0 if no reviews
   */
  getAverageRating(listingId) {
    const reviews = this.#reviews.get(listingId);
    if (!reviews || reviews.length === 0) return 0;
    const sum = reviews.reduce((acc, r) => acc + r.rating, 0);
    return sum / reviews.length;
  }

  // -- Categories -----------------------------------------------------------

  /**
   * Get all distinct categories.
   * @returns {string[]}
   */
  getCategories() {
    const cats = new Set();
    for (const listing of this.#listings.values()) {
      cats.add(listing.category);
    }
    return [...cats];
  }

  // -- Featured -------------------------------------------------------------

  /**
   * Get top-rated active listings.
   * @param {number} [limit=10]
   * @returns {ServiceListing[]}
   */
  getFeatured(limit = 10) {
    const active = [];
    for (const listing of this.#listings.values()) {
      if (listing.status !== 'active') continue;
      const avg = this.getAverageRating(listing.id);
      active.push({ listing, avg });
    }
    active.sort((a, b) => b.avg - a.avg);
    return active.slice(0, limit).map(e => e.listing);
  }

  // -- Callbacks ------------------------------------------------------------

  /**
   * @param {function(ServiceListing)} cb
   */
  onPublish(cb) {
    this.#onPublish.push(cb);
  }

  /**
   * @param {function(string)} cb - receives listingId
   */
  onUnpublish(cb) {
    this.#onUnpublish.push(cb);
  }

  /**
   * @param {function(ServiceReview)} cb
   */
  onReview(cb) {
    this.#onReview.push(cb);
  }

  // -- Stats ----------------------------------------------------------------

  /**
   * @returns {{ totalListings: number, activeListings: number, totalReviews: number, avgRating: number }}
   */
  getStats() {
    let activeCount = 0;
    let totalReviewCount = 0;
    let ratingSum = 0;

    for (const listing of this.#listings.values()) {
      if (listing.status === 'active') activeCount++;
    }

    for (const reviews of this.#reviews.values()) {
      totalReviewCount += reviews.length;
      for (const r of reviews) {
        ratingSum += r.rating;
      }
    }

    return {
      totalListings: this.#listings.size,
      activeListings: activeCount,
      totalReviews: totalReviewCount,
      avgRating: totalReviewCount > 0 ? ratingSum / totalReviewCount : 0,
    };
  }

  // -- Serialization --------------------------------------------------------

  toJSON() {
    const listings = [];
    for (const l of this.#listings.values()) {
      listings.push(l.toJSON());
    }
    const reviews = {};
    for (const [listingId, revs] of this.#reviews) {
      reviews[listingId] = revs.map(r => r.toJSON());
    }
    return {
      localPodId: this.#localPodId,
      listings,
      reviews,
    };
  }

  /**
   * @param {object} data
   * @returns {Marketplace}
   */
  static fromJSON(data) {
    const mp = new Marketplace({ localPodId: data.localPodId });

    // Restore listings
    if (data.listings) {
      for (const ld of data.listings) {
        const listing = ServiceListing.fromJSON(ld);
        mp.#listings.set(listing.id, listing);
        mp.#index.addListing(listing);
      }
    }

    // Restore reviews
    if (data.reviews) {
      for (const [listingId, revs] of Object.entries(data.reviews)) {
        const reviewList = revs.map(rd => ServiceReview.fromJSON(rd));
        mp.#reviews.set(listingId, reviewList);
        for (const r of reviewList) {
          mp.#reviewIds.add(r.id);
        }
      }
    }

    return mp;
  }
}

// ---------------------------------------------------------------------------
// MarketplaceIndex
// ---------------------------------------------------------------------------

/**
 * Efficient inverted index for marketplace queries.
 */
export class MarketplaceIndex {
  /** @type {Map<string, Set<string>>} category -> listing IDs */
  #byCategory = new Map();
  /** @type {Map<string, Set<string>>} tag -> listing IDs */
  #byTag = new Map();
  /** @type {Map<string, Set<string>>} providerPodId -> listing IDs */
  #byProvider = new Map();
  /** @type {Map<string, ServiceListing>} id -> listing (for full-text search) */
  #listingCache = new Map();

  /**
   * Index a listing.
   * @param {ServiceListing} listing
   */
  addListing(listing) {
    // Cache for full-text search
    this.#listingCache.set(listing.id, listing);

    // Category index
    if (!this.#byCategory.has(listing.category)) {
      this.#byCategory.set(listing.category, new Set());
    }
    this.#byCategory.get(listing.category).add(listing.id);

    // Tag indexes
    for (const tag of listing.tags) {
      if (!this.#byTag.has(tag)) {
        this.#byTag.set(tag, new Set());
      }
      this.#byTag.get(tag).add(listing.id);
    }

    // Provider index
    if (!this.#byProvider.has(listing.providerPodId)) {
      this.#byProvider.set(listing.providerPodId, new Set());
    }
    this.#byProvider.get(listing.providerPodId).add(listing.id);
  }

  /**
   * Remove a listing from all indexes.
   * @param {string} listingId
   */
  removeListing(listingId) {
    const listing = this.#listingCache.get(listingId);
    if (!listing) return;

    // Category
    const catSet = this.#byCategory.get(listing.category);
    if (catSet) {
      catSet.delete(listingId);
      if (catSet.size === 0) this.#byCategory.delete(listing.category);
    }

    // Tags
    for (const tag of listing.tags) {
      const tagSet = this.#byTag.get(tag);
      if (tagSet) {
        tagSet.delete(listingId);
        if (tagSet.size === 0) this.#byTag.delete(tag);
      }
    }

    // Provider
    const provSet = this.#byProvider.get(listing.providerPodId);
    if (provSet) {
      provSet.delete(listingId);
      if (provSet.size === 0) this.#byProvider.delete(listing.providerPodId);
    }

    this.#listingCache.delete(listingId);
  }

  /**
   * O(1) lookup by category.
   * @param {string} category
   * @returns {string[]} listing IDs
   */
  queryByCategory(category) {
    const set = this.#byCategory.get(category);
    return set ? [...set] : [];
  }

  /**
   * O(1) lookup by tag.
   * @param {string} tag
   * @returns {string[]} listing IDs
   */
  queryByTag(tag) {
    const set = this.#byTag.get(tag);
    return set ? [...set] : [];
  }

  /**
   * O(1) lookup by provider.
   * @param {string} podId
   * @returns {string[]} listing IDs
   */
  queryByProvider(podId) {
    const set = this.#byProvider.get(podId);
    return set ? [...set] : [];
  }

  /**
   * Full-text search across name, description, and tags.
   * @param {string} text
   * @returns {string[]} matching listing IDs (deduplicated)
   */
  fullTextSearch(text) {
    if (!text || text.length === 0) return [];

    const q = text.toLowerCase();
    const matched = new Set();

    for (const [id, listing] of this.#listingCache) {
      if (listing.name.toLowerCase().includes(q)) {
        matched.add(id);
        continue;
      }
      if (listing.description.toLowerCase().includes(q)) {
        matched.add(id);
        continue;
      }
      for (const tag of listing.tags) {
        if (tag.toLowerCase().includes(q)) {
          matched.add(id);
          break;
        }
      }
    }

    return [...matched];
  }
}
