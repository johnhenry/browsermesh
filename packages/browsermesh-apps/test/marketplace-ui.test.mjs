// Run with: node --import ./test/_setup-globals.mjs --test test/marketplace-ui.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../src/marketplace-ui.mjs');
const { SkillMarketplace } = mod;

// ── Mock catalog ─────────────────────────────────────────────────
const MOCK_CATALOG = {
  skills: [
    {
      id: 'web-search',
      name: 'Web Search',
      description: 'Search the web and return results',
      author: 'clawser',
      version: '1.0.0',
      category: 'search',
      tags: ['web', 'search', 'query'],
      rating: 4.5,
      ratingCount: 12,
      downloads: 250,
    },
    {
      id: 'code-review',
      name: 'Code Review',
      description: 'Automated code review and suggestions',
      author: 'devtools',
      version: '0.9.0',
      category: 'developer',
      tags: ['code', 'review', 'lint'],
      rating: 4.2,
      ratingCount: 8,
      downloads: 180,
    },
    {
      id: 'summarizer',
      name: 'Text Summarizer',
      description: 'Summarize long documents into key points',
      author: 'clawser',
      version: '1.1.0',
      category: 'text',
      tags: ['summarize', 'text', 'tldr'],
      rating: 4.8,
      ratingCount: 20,
      downloads: 400,
    },
  ],
  categories: ['search', 'developer', 'text', 'automation', 'data'],
};

// ── 1. Construction ──────────────────────────────────────────────

describe('SkillMarketplace construction', () => {
  it('can be constructed with catalog data', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    assert.ok(mp);
  });

  it('can be constructed without args (empty catalog)', () => {
    const mp = new SkillMarketplace();
    assert.ok(mp);
  });
});

// ── 2. getCatalog ────────────────────────────────────────────────

describe('getCatalog', () => {
  it('returns all skills', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const catalog = mp.getCatalog();
    assert.equal(catalog.skills.length, 3);
  });

  it('returns categories', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const catalog = mp.getCatalog();
    assert.ok(Array.isArray(catalog.categories));
    assert.ok(catalog.categories.length > 0);
  });
});

// ── 3. browse ────────────────────────────────────────────────────

describe('browse', () => {
  it('returns all skills for empty query', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const results = mp.browse('');
    assert.equal(results.length, 3);
  });

  it('filters by query string (name match)', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const results = mp.browse('search');
    assert.ok(results.length >= 1);
    assert.ok(results.some(s => s.id === 'web-search'));
  });

  it('filters by query string (tag match)', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const results = mp.browse('lint');
    assert.ok(results.length >= 1);
    assert.ok(results.some(s => s.id === 'code-review'));
  });

  it('filters by category', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const results = mp.browse('', { category: 'developer' });
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'code-review');
  });

  it('sorts by downloads desc by default', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const results = mp.browse('');
    assert.ok(results[0].downloads >= results[1].downloads);
  });

  it('sorts by rating when specified', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const results = mp.browse('', { sort: 'rating' });
    assert.ok(results[0].rating >= results[1].rating);
  });

  it('returns empty array for no matches', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const results = mp.browse('zzzznonexistent');
    assert.equal(results.length, 0);
  });
});

// ── 4. rate ──────────────────────────────────────────────────────

describe('rate', () => {
  it('updates skill rating', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const updated = mp.rate('web-search', 5);
    assert.ok(updated);
    assert.ok(updated.ratingCount > 12);
  });

  it('clamps stars to 1-5 range', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const updated = mp.rate('web-search', 10);
    assert.ok(updated.rating <= 5);
  });

  it('returns null for unknown skill', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const result = mp.rate('nonexistent', 3);
    assert.equal(result, null);
  });
});

// ── 5. install ───────────────────────────────────────────────────

describe('install', () => {
  it('tracks installed skill', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const result = mp.install('web-search');
    assert.equal(result.installed, true);
    assert.equal(result.skillId, 'web-search');
  });

  it('increments download count', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const before = mp.browse('').find(s => s.id === 'web-search').downloads;
    mp.install('web-search');
    const after = mp.browse('').find(s => s.id === 'web-search').downloads;
    assert.equal(after, before + 1);
  });

  it('returns error for unknown skill', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    const result = mp.install('nonexistent');
    assert.equal(result.installed, false);
    assert.ok(result.error);
  });

  it('lists installed skills', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    mp.install('web-search');
    mp.install('summarizer');
    const installed = mp.getInstalled();
    assert.equal(installed.length, 2);
  });

  it('uninstall removes skill', () => {
    const mp = new SkillMarketplace(MOCK_CATALOG);
    mp.install('web-search');
    mp.uninstall('web-search');
    const installed = mp.getInstalled();
    assert.equal(installed.length, 0);
  });
});
