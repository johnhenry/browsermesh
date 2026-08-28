/**
 * Clawser Skill Marketplace
 *
 * Browse, search, rate, and install agent skills from a catalog.
 * The catalog is loaded from a JSON source (local or remote).
 * Installed skills are tracked in memory and can be persisted
 * to localStorage or OPFS by the caller.
 *
 * Catalog format:
 * {
 *   skills: [{ id, name, description, author, version, category, tags, rating, ratingCount, downloads }],
 *   categories: string[]
 * }
 */

// ── SkillMarketplace ─────────────────────────────────────────────

export class SkillMarketplace {
  /** @type {{ skills: object[], categories: string[] }} */
  #catalog;

  /** @type {Set<string>} */
  #installed = new Set();

  /** @type {Map<string, number>} User's ratings: skillId → stars */
  #userRatings = new Map();

  /**
   * @param {object} [catalog] - Initial catalog data
   * @param {object[]} [catalog.skills] - Array of skill entries
   * @param {string[]} [catalog.categories] - Available category names
   */
  constructor(catalog = null) {
    this.#catalog = catalog
      ? { skills: [...catalog.skills.map(s => ({ ...s }))], categories: [...(catalog.categories || [])] }
      : { skills: [], categories: [] };
  }

  /**
   * Load or replace the catalog from a JSON object.
   * @param {object} catalogData
   */
  loadCatalog(catalogData) {
    this.#catalog = {
      skills: [...catalogData.skills.map(s => ({ ...s }))],
      categories: [...(catalogData.categories || [])],
    };
  }

  /**
   * Load catalog from a URL (fetches JSON).
   * @param {string} url
   * @returns {Promise<void>}
   */
  async loadCatalogFromUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch catalog: ${resp.status}`);
    const data = await resp.json();
    this.loadCatalog(data);
  }

  /**
   * Get the full catalog.
   * @returns {{ skills: object[], categories: string[] }}
   */
  getCatalog() {
    return {
      skills: this.#catalog.skills.map(s => ({ ...s })),
      categories: [...this.#catalog.categories],
    };
  }

  /**
   * Browse / search skills.
   * @param {string} query - Text query (matches name, description, tags)
   * @param {object} [opts]
   * @param {string} [opts.category] - Filter by category
   * @param {string} [opts.author] - Filter by author
   * @param {string} [opts.sort='downloads'] - Sort by: 'downloads' | 'rating' | 'name'
   * @param {number} [opts.limit=50] - Max results
   * @returns {object[]}
   */
  browse(query = '', opts = {}) {
    let results = [...this.#catalog.skills];

    // Text search
    if (query) {
      const q = query.toLowerCase();
      results = results.filter(s => {
        const haystack = [
          s.name,
          s.description,
          s.author,
          ...(s.tags || []),
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    // Category filter
    if (opts.category) {
      results = results.filter(s => s.category === opts.category);
    }

    // Author filter
    if (opts.author) {
      results = results.filter(s => s.author === opts.author);
    }

    // Sort
    const sortField = opts.sort || 'downloads';
    switch (sortField) {
      case 'rating':
        results.sort((a, b) => (b.rating || 0) - (a.rating || 0));
        break;
      case 'name':
        results.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'downloads':
      default:
        results.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
        break;
    }

    // Limit
    const limit = opts.limit || 50;
    return results.slice(0, limit);
  }

  /**
   * Rate a skill. Computes a weighted average incorporating the new rating.
   * @param {string} skillId
   * @param {number} stars - 1 to 5
   * @returns {object|null} Updated skill entry, or null if not found
   */
  rate(skillId, stars) {
    const clamped = Math.max(1, Math.min(5, stars));
    const skill = this.#catalog.skills.find(s => s.id === skillId);
    if (!skill) return null;

    // Weighted average: (oldRating * oldCount + newRating) / (oldCount + 1)
    const oldRating = skill.rating || 0;
    const oldCount = skill.ratingCount || 0;
    skill.ratingCount = oldCount + 1;
    skill.rating = Math.round(((oldRating * oldCount + clamped) / skill.ratingCount) * 100) / 100;

    this.#userRatings.set(skillId, clamped);

    return { ...skill };
  }

  /**
   * Mark a skill as installed. Increments the download counter.
   * @param {string} skillId
   * @returns {{ installed: boolean, skillId: string, error?: string }}
   */
  install(skillId) {
    const skill = this.#catalog.skills.find(s => s.id === skillId);
    if (!skill) {
      return { installed: false, skillId, error: `Skill not found: ${skillId}` };
    }

    this.#installed.add(skillId);
    skill.downloads = (skill.downloads || 0) + 1;

    return { installed: true, skillId, name: skill.name, version: skill.version };
  }

  /**
   * Uninstall (remove from installed set).
   * @param {string} skillId
   * @returns {{ uninstalled: boolean, skillId: string }}
   */
  uninstall(skillId) {
    const removed = this.#installed.delete(skillId);
    return { uninstalled: removed, skillId };
  }

  /**
   * Get list of installed skill IDs.
   * @returns {string[]}
   */
  getInstalled() {
    return [...this.#installed];
  }

  /**
   * Check if a specific skill is installed.
   * @param {string} skillId
   * @returns {boolean}
   */
  isInstalled(skillId) {
    return this.#installed.has(skillId);
  }

  /**
   * Get a single skill by ID.
   * @param {string} skillId
   * @returns {object|null}
   */
  getSkill(skillId) {
    const skill = this.#catalog.skills.find(s => s.id === skillId);
    return skill ? { ...skill, installed: this.#installed.has(skillId) } : null;
  }

  /**
   * Get the user's rating for a skill.
   * @param {string} skillId
   * @returns {number|null}
   */
  getUserRating(skillId) {
    return this.#userRatings.get(skillId) ?? null;
  }

  /**
   * Get all categories.
   * @returns {string[]}
   */
  getCategories() {
    return [...this.#catalog.categories];
  }

  /**
   * Export installed list as JSON (for persistence).
   * @returns {string}
   */
  exportInstalledJSON() {
    return JSON.stringify([...this.#installed]);
  }

  /**
   * Import installed list from JSON.
   * @param {string} json
   */
  importInstalledJSON(json) {
    try {
      const ids = JSON.parse(json);
      if (Array.isArray(ids)) {
        for (const id of ids) this.#installed.add(id);
      }
    } catch {
      // ignore malformed JSON
    }
  }
}
