/**
 * CRDT (Conflict-free Replicated Data Types) for mesh-primitives.
 *
 * Pure, deterministic, zero-dependency implementations suitable for
 * browser-to-browser state synchronization in BrowserMesh.
 */

// ── VectorClock ─────────────────────────────────────────────────────────────

/**
 * A vector clock tracks causal ordering across distributed nodes.
 * Each node maintains a monotonically increasing counter.
 */
export class VectorClock {
  /** @type {Map<string, number>} */
  #entries;

  /**
   * @param {Map<string, number> | Iterable<[string, number]>} [entries]
   */
  constructor(entries = new Map()) {
    this.#entries = new Map(entries);
  }

  /**
   * Increment the counter for the given node and return this clock.
   * @param {string} nodeId
   * @returns {VectorClock} this
   */
  increment(nodeId) {
    this.#entries.set(nodeId, (this.#entries.get(nodeId) ?? 0) + 1);
    return this;
  }

  /**
   * Get the counter value for a node (0 if absent).
   * @param {string} nodeId
   * @returns {number}
   */
  get(nodeId) {
    return this.#entries.get(nodeId) ?? 0;
  }

  /**
   * Merge with another VectorClock, taking the max of each entry.
   * Returns a new VectorClock.
   * @param {VectorClock} other
   * @returns {VectorClock}
   */
  merge(other) {
    const merged = new Map(this.#entries);
    const otherEntries = other.#entries;
    for (const [nodeId, count] of otherEntries) {
      merged.set(nodeId, Math.max(merged.get(nodeId) ?? 0, count));
    }
    return new VectorClock(merged);
  }

  /**
   * Compare this clock with another.
   * @param {VectorClock} other
   * @returns {'before' | 'after' | 'concurrent' | 'equal'}
   */
  compare(other) {
    const allKeys = new Set([...this.#entries.keys(), ...other.#entries.keys()]);
    let hasLess = false;
    let hasGreater = false;

    for (const key of allKeys) {
      const a = this.get(key);
      const b = other.get(key);
      if (a < b) hasLess = true;
      if (a > b) hasGreater = true;
      if (hasLess && hasGreater) return 'concurrent';
    }

    if (!hasLess && !hasGreater) return 'equal';
    if (hasLess) return 'before';
    return 'after';
  }

  /**
   * Serialize to a plain object.
   * @returns {Record<string, number>}
   */
  toJSON() {
    const obj = {};
    for (const [k, v] of this.#entries) obj[k] = v;
    return obj;
  }

  /**
   * Reconstruct from a plain object.
   * @param {Record<string, number>} data
   * @returns {VectorClock}
   */
  static fromJSON(data) {
    return new VectorClock(new Map(Object.entries(data)));
  }
}

// ── LWWRegister ─────────────────────────────────────────────────────────────

/**
 * A Last-Writer-Wins Register. Conflicts are resolved by timestamp;
 * ties are broken by nodeId (lexicographic, higher wins).
 */
export class LWWRegister {
  #value;
  #timestamp;
  #nodeId;

  /**
   * @param {*} [value=null]
   * @param {number} [timestamp=0]
   * @param {string} [nodeId='']
   */
  constructor(value = null, timestamp = 0, nodeId = '') {
    this.#value = value;
    this.#timestamp = timestamp;
    this.#nodeId = nodeId;
  }

  /** @returns {*} Current value */
  get value() {
    return this.#value;
  }

  /**
   * Update the register if the new write is newer.
   * @param {*} value
   * @param {number} timestamp
   * @param {string} nodeId
   */
  set(value, timestamp, nodeId) {
    if (
      timestamp > this.#timestamp ||
      (timestamp === this.#timestamp && nodeId > this.#nodeId)
    ) {
      this.#value = value;
      this.#timestamp = timestamp;
      this.#nodeId = nodeId;
    }
  }

  /**
   * Merge with another LWWRegister, keeping the latest value.
   * Returns a new LWWRegister.
   * @param {LWWRegister} other
   * @returns {LWWRegister}
   */
  merge(other) {
    const otherState = other.state();
    const thisState = this.state();

    if (
      otherState.timestamp > thisState.timestamp ||
      (otherState.timestamp === thisState.timestamp && otherState.nodeId > thisState.nodeId)
    ) {
      return new LWWRegister(otherState.value, otherState.timestamp, otherState.nodeId);
    }
    return new LWWRegister(thisState.value, thisState.timestamp, thisState.nodeId);
  }

  /**
   * @returns {{ value: *, timestamp: number, nodeId: string }}
   */
  state() {
    return { value: this.#value, timestamp: this.#timestamp, nodeId: this.#nodeId };
  }

  toJSON() {
    return { value: this.#value, timestamp: this.#timestamp, nodeId: this.#nodeId };
  }

  /**
   * @param {{ value: *, timestamp: number, nodeId: string }} data
   * @returns {LWWRegister}
   */
  static fromJSON(data) {
    return new LWWRegister(data.value, data.timestamp, data.nodeId);
  }
}

// ── GCounter ────────────────────────────────────────────────────────────────

/**
 * Grow-only counter. Each node maintains its own monotonic counter.
 * The total value is the sum of all per-node counters.
 */
export class GCounter {
  /** @type {Map<string, number>} */
  #counts;

  /**
   * @param {Map<string, number> | Iterable<[string, number]>} [counts]
   */
  constructor(counts = new Map()) {
    this.#counts = new Map(counts);
  }

  /** @returns {number} Sum of all node counters */
  get value() {
    let sum = 0;
    for (const v of this.#counts.values()) sum += v;
    return sum;
  }

  /**
   * Increment the counter for a node.
   * @param {string} nodeId
   * @param {number} [amount=1]
   */
  increment(nodeId, amount = 1) {
    if (amount < 0) throw new RangeError('GCounter increment amount must be non-negative');
    this.#counts.set(nodeId, (this.#counts.get(nodeId) ?? 0) + amount);
  }

  /**
   * Merge with another GCounter, taking the max per node.
   * Returns a new GCounter.
   * @param {GCounter} other
   * @returns {GCounter}
   */
  merge(other) {
    const merged = new Map(this.#counts);
    const otherCounts = other.state();
    for (const [nodeId, count] of otherCounts) {
      merged.set(nodeId, Math.max(merged.get(nodeId) ?? 0, count));
    }
    return new GCounter(merged);
  }

  /**
   * @returns {Map<string, number>} Copy of internal counters
   */
  state() {
    return new Map(this.#counts);
  }

  toJSON() {
    const obj = {};
    for (const [k, v] of this.#counts) obj[k] = v;
    return obj;
  }

  /**
   * @param {Record<string, number>} data
   * @returns {GCounter}
   */
  static fromJSON(data) {
    return new GCounter(new Map(Object.entries(data)));
  }
}

// ── PNCounter ───────────────────────────────────────────────────────────────

/**
 * Positive-Negative Counter. Composed of two GCounters:
 * one for increments and one for decrements.
 */
export class PNCounter {
  /** @type {GCounter} */
  #pos;
  /** @type {GCounter} */
  #neg;

  /**
   * @param {GCounter} [pos]
   * @param {GCounter} [neg]
   */
  constructor(pos = new GCounter(), neg = new GCounter()) {
    this.#pos = pos;
    this.#neg = neg;
  }

  /** @returns {number} pos.value - neg.value */
  get value() {
    return this.#pos.value - this.#neg.value;
  }

  /**
   * Increment the counter.
   * @param {string} nodeId
   * @param {number} [amount=1]
   */
  increment(nodeId, amount = 1) {
    this.#pos.increment(nodeId, amount);
  }

  /**
   * Decrement the counter.
   * @param {string} nodeId
   * @param {number} [amount=1]
   */
  decrement(nodeId, amount = 1) {
    this.#neg.increment(nodeId, amount);
  }

  /**
   * Merge with another PNCounter.
   * Returns a new PNCounter.
   * @param {PNCounter} other
   * @returns {PNCounter}
   */
  merge(other) {
    const otherState = other.state();
    return new PNCounter(this.#pos.merge(otherState.pos), this.#neg.merge(otherState.neg));
  }

  /**
   * @returns {{ pos: GCounter, neg: GCounter }}
   */
  state() {
    return { pos: this.#pos, neg: this.#neg };
  }

  toJSON() {
    return { pos: this.#pos.toJSON(), neg: this.#neg.toJSON() };
  }

  /**
   * @param {{ pos: Record<string, number>, neg: Record<string, number> }} data
   * @returns {PNCounter}
   */
  static fromJSON(data) {
    return new PNCounter(GCounter.fromJSON(data.pos), GCounter.fromJSON(data.neg));
  }
}

// ── ORSet ───────────────────────────────────────────────────────────────────

/**
 * Observed-Remove Set.
 * Each add generates a unique tag; remove tombstones all current tags for an element.
 * Concurrent add + remove results in the element being present (add wins).
 */
export class ORSet {
  /** @type {Map<*, Set<string>>} element -> set of unique tags */
  #elements;
  /** @type {Set<string>} removed tags */
  #tombstones;
  /** @type {number} auto-incrementing tag counter */
  #counter;

  constructor() {
    this.#elements = new Map();
    this.#tombstones = new Set();
    this.#counter = 0;
  }

  /** @returns {Set<*>} Current live elements */
  get value() {
    const result = new Set();
    for (const [element, tags] of this.#elements) {
      for (const tag of tags) {
        if (!this.#tombstones.has(tag)) {
          result.add(element);
          break;
        }
      }
    }
    return result;
  }

  /**
   * Add an element with a unique tag.
   * @param {*} element
   * @param {string} nodeId
   */
  add(element, nodeId) {
    const tag = `${nodeId}:${this.#counter++}`;
    if (!this.#elements.has(element)) {
      this.#elements.set(element, new Set());
    }
    this.#elements.get(element).add(tag);
  }

  /**
   * Remove an element by tombstoning all its current tags.
   * @param {*} element
   */
  remove(element) {
    const tags = this.#elements.get(element);
    if (tags) {
      for (const tag of tags) {
        this.#tombstones.add(tag);
      }
    }
  }

  /**
   * Check if element is currently in the set.
   * @param {*} element
   * @returns {boolean}
   */
  has(element) {
    const tags = this.#elements.get(element);
    if (!tags) return false;
    for (const tag of tags) {
      if (!this.#tombstones.has(tag)) return true;
    }
    return false;
  }

  /**
   * Merge with another ORSet.
   * Union of elements minus union of tombstones.
   * Returns a new ORSet.
   * @param {ORSet} other
   * @returns {ORSet}
   */
  merge(other) {
    const otherState = other.state();
    const merged = new ORSet();

    // Union all elements and their tags
    const allElements = new Map();
    for (const [element, tags] of this.#elements) {
      allElements.set(element, new Set(tags));
    }
    for (const [element, tags] of otherState.elements) {
      if (!allElements.has(element)) {
        allElements.set(element, new Set());
      }
      const existing = allElements.get(element);
      for (const tag of tags) {
        existing.add(tag);
      }
    }

    // Union all tombstones
    const allTombstones = new Set([...this.#tombstones, ...otherState.tombstones]);

    // Set internal state on the merged ORSet via its _setInternal method
    merged._setInternal(allElements, allTombstones);
    return merged;
  }

  /**
   * Internal method to set state during merge/fromJSON.
   * @param {Map<*, Set<string>>} elements
   * @param {Set<string>} tombstones
   */
  _setInternal(elements, tombstones) {
    this.#elements = elements;
    this.#tombstones = tombstones;
    // Compute max counter from existing tags
    let maxCounter = 0;
    for (const tags of elements.values()) {
      for (const tag of tags) {
        const parts = tag.split(':');
        const num = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(num) && num >= maxCounter) maxCounter = num + 1;
      }
    }
    this.#counter = maxCounter;
  }

  /**
   * @returns {{ elements: Map<*, Set<string>>, tombstones: Set<string> }}
   */
  state() {
    // Return deep copies
    const elements = new Map();
    for (const [k, v] of this.#elements) {
      elements.set(k, new Set(v));
    }
    return { elements, tombstones: new Set(this.#tombstones) };
  }

  toJSON() {
    const elements = [];
    for (const [element, tags] of this.#elements) {
      elements.push({ element, tags: [...tags] });
    }
    return { elements, tombstones: [...this.#tombstones] };
  }

  /**
   * @param {{ elements: Array<{ element: *, tags: string[] }>, tombstones: string[] }} data
   * @returns {ORSet}
   */
  static fromJSON(data) {
    const set = new ORSet();
    const elements = new Map();
    for (const { element, tags } of data.elements) {
      elements.set(element, new Set(tags));
    }
    set._setInternal(elements, new Set(data.tombstones));
    return set;
  }
}

// ── RGA ─────────────────────────────────────────────────────────────────────

/**
 * Replicated Growable Array.
 * An ordered sequence that supports concurrent insertions via unique node IDs.
 * Deleted elements are tombstoned.
 */
export class RGA {
  /** @type {Array<{ id: string, value: *, deleted: boolean }>} */
  #nodes;
  /** @type {VectorClock} */
  #vclock;

  constructor() {
    this.#nodes = [];
    this.#vclock = new VectorClock();
  }

  /** @returns {Array<*>} Non-deleted values in order */
  get value() {
    return this.#nodes.filter(n => !n.deleted).map(n => n.value);
  }

  /** @returns {number} Count of non-deleted elements */
  get length() {
    return this.#nodes.filter(n => !n.deleted).length;
  }

  /**
   * Insert a value at the given logical index (among non-deleted elements).
   * @param {number} index - Position among visible elements (0 = beginning)
   * @param {*} value
   * @param {string} nodeId
   */
  insertAt(index, value, nodeId) {
    this.#vclock.increment(nodeId);
    const seq = this.#vclock.get(nodeId);
    const id = `${nodeId}:${seq}`;
    const newNode = { id, value, deleted: false };

    // Map visible index to physical position
    const physicalIndex = this._visibleToPhysical(index);
    this.#nodes.splice(physicalIndex, 0, newNode);
  }

  /**
   * Delete the element at the given logical index.
   * @param {number} index - Position among visible elements
   */
  deleteAt(index) {
    const physicalIndex = this._visibleToPhysical(index);
    // The physical index from _visibleToPhysical for an existing element:
    // we need the element AT the index, not after it
    // Find the physical index of the nth visible element
    let count = 0;
    for (let i = 0; i < this.#nodes.length; i++) {
      if (!this.#nodes[i].deleted) {
        if (count === index) {
          this.#nodes[i].deleted = true;
          return;
        }
        count++;
      }
    }
    throw new RangeError(`Index ${index} out of bounds`);
  }

  /**
   * Convert a visible index to a physical insertion position.
   * @param {number} visibleIndex
   * @returns {number}
   */
  _visibleToPhysical(visibleIndex) {
    if (visibleIndex === 0) return 0;
    let count = 0;
    for (let i = 0; i < this.#nodes.length; i++) {
      if (!this.#nodes[i].deleted) {
        count++;
        if (count === visibleIndex) return i + 1;
      }
    }
    // If index equals the number of visible elements, append
    if (count === visibleIndex) return this.#nodes.length;
    // If beyond visible count, also append
    return this.#nodes.length;
  }

  /**
   * Merge with another RGA. Interleaves based on node IDs for
   * deterministic conflict resolution.
   * @param {RGA} other
   * @returns {RGA}
   */
  merge(other) {
    const otherState = other.state();
    const merged = new RGA();

    // Build a set of all nodes from both sides, keyed by id
    const nodeMap = new Map();
    for (const node of this.#nodes) {
      nodeMap.set(node.id, { ...node });
    }
    for (const node of otherState.nodes) {
      if (nodeMap.has(node.id)) {
        // If either side deleted it, it stays deleted
        const existing = nodeMap.get(node.id);
        existing.deleted = existing.deleted || node.deleted;
      } else {
        nodeMap.set(node.id, { ...node });
      }
    }

    // Merge the two ordered sequences
    const mergedNodes = this._mergeSequences(this.#nodes, otherState.nodes, nodeMap);
    merged._setInternal(mergedNodes, this.#vclock.merge(otherState.vclock));
    return merged;
  }

  /**
   * Merge two node sequences, preserving local order and interleaving
   * concurrent insertions deterministically by ID.
   * @param {Array} seqA
   * @param {Array} seqB
   * @param {Map} nodeMap - merged node states
   * @returns {Array}
   */
  _mergeSequences(seqA, seqB, nodeMap) {
    const result = [];
    const seen = new Set();
    let i = 0;
    let j = 0;

    while (i < seqA.length || j < seqB.length) {
      // Skip already-seen nodes
      while (i < seqA.length && seen.has(seqA[i].id)) i++;
      while (j < seqB.length && seen.has(seqB[j].id)) j++;

      if (i >= seqA.length && j >= seqB.length) break;

      if (i >= seqA.length) {
        // Only B has remaining
        const node = nodeMap.get(seqB[j].id);
        if (!seen.has(node.id)) {
          result.push(node);
          seen.add(node.id);
        }
        j++;
      } else if (j >= seqB.length) {
        // Only A has remaining
        const node = nodeMap.get(seqA[i].id);
        if (!seen.has(node.id)) {
          result.push(node);
          seen.add(node.id);
        }
        i++;
      } else if (seqA[i].id === seqB[j].id) {
        // Same node in both
        const node = nodeMap.get(seqA[i].id);
        if (!seen.has(node.id)) {
          result.push(node);
          seen.add(node.id);
        }
        i++;
        j++;
      } else {
        // Different nodes: check if either appears later in the other sequence
        const aInB = seqB.slice(j).some(n => n.id === seqA[i].id);
        const bInA = seqA.slice(i).some(n => n.id === seqB[j].id);

        if (aInB && !bInA) {
          // B's node is unique to B, insert it first
          const node = nodeMap.get(seqB[j].id);
          if (!seen.has(node.id)) {
            result.push(node);
            seen.add(node.id);
          }
          j++;
        } else if (bInA && !aInB) {
          // A's node is unique to A, insert it first
          const node = nodeMap.get(seqA[i].id);
          if (!seen.has(node.id)) {
            result.push(node);
            seen.add(node.id);
          }
          i++;
        } else {
          // Both are concurrent (or both in each other's sequence)
          // Deterministic tiebreak: lower ID first
          if (seqA[i].id < seqB[j].id) {
            const node = nodeMap.get(seqA[i].id);
            if (!seen.has(node.id)) {
              result.push(node);
              seen.add(node.id);
            }
            i++;
          } else {
            const node = nodeMap.get(seqB[j].id);
            if (!seen.has(node.id)) {
              result.push(node);
              seen.add(node.id);
            }
            j++;
          }
        }
      }
    }

    return result;
  }

  /**
   * Internal method to set state during merge/fromJSON.
   * @param {Array<{ id: string, value: *, deleted: boolean }>} nodes
   * @param {VectorClock} vclock
   */
  _setInternal(nodes, vclock) {
    this.#nodes = nodes;
    this.#vclock = vclock;
  }

  /**
   * @returns {{ nodes: Array<{ id: string, value: *, deleted: boolean }>, vclock: VectorClock }}
   */
  state() {
    return {
      nodes: this.#nodes.map(n => ({ ...n })),
      vclock: this.#vclock,
    };
  }

  toJSON() {
    return {
      nodes: this.#nodes.map(n => ({ id: n.id, value: n.value, deleted: n.deleted })),
      vclock: this.#vclock.toJSON(),
    };
  }

  /**
   * @param {{ nodes: Array<{ id: string, value: *, deleted: boolean }>, vclock: Record<string, number> }} data
   * @returns {RGA}
   */
  static fromJSON(data) {
    const rga = new RGA();
    rga._setInternal(
      data.nodes.map(n => ({ id: n.id, value: n.value, deleted: n.deleted })),
      VectorClock.fromJSON(data.vclock),
    );
    return rga;
  }
}

// ── LWWMap ──────────────────────────────────────────────────────────────────

/** Sentinel for deleted entries in LWWMap */
const TOMBSTONE = Symbol('TOMBSTONE');

/** Sentinel string for JSON serialization of tombstones */
const TOMBSTONE_JSON = '__TOMBSTONE__';

/**
 * Last-Writer-Wins Map.
 * Each key is backed by an LWWRegister. Deletions are represented
 * by a sentinel TOMBSTONE value.
 */
export class LWWMap {
  /** @type {Map<string, LWWRegister>} */
  #entries;

  constructor() {
    this.#entries = new Map();
  }

  /** @returns {Record<string, *>} Plain object of live key-value pairs */
  get value() {
    const obj = {};
    for (const [key, reg] of this.#entries) {
      if (reg.value !== TOMBSTONE) {
        obj[key] = reg.value;
      }
    }
    return obj;
  }

  /** @returns {number} Count of live (non-tombstoned) entries */
  get size() {
    let count = 0;
    for (const reg of this.#entries.values()) {
      if (reg.value !== TOMBSTONE) count++;
    }
    return count;
  }

  /**
   * Set or update a key.
   * @param {string} key
   * @param {*} value
   * @param {number} timestamp
   * @param {string} nodeId
   */
  set(key, value, timestamp, nodeId) {
    if (!this.#entries.has(key)) {
      this.#entries.set(key, new LWWRegister(value, timestamp, nodeId));
    } else {
      this.#entries.get(key).set(value, timestamp, nodeId);
    }
  }

  /**
   * Delete a key by writing the TOMBSTONE sentinel.
   * @param {string} key
   * @param {number} timestamp
   * @param {string} nodeId
   */
  delete(key, timestamp, nodeId) {
    this.set(key, TOMBSTONE, timestamp, nodeId);
  }

  /**
   * Get the value for a key, or undefined if missing/tombstoned.
   * @param {string} key
   * @returns {*}
   */
  get(key) {
    const reg = this.#entries.get(key);
    if (!reg || reg.value === TOMBSTONE) return undefined;
    return reg.value;
  }

  /**
   * Check if a key exists and is not tombstoned.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    const reg = this.#entries.get(key);
    return reg !== undefined && reg.value !== TOMBSTONE;
  }

  /**
   * Merge with another LWWMap. Merges each key's register.
   * Returns a new LWWMap.
   * @param {LWWMap} other
   * @returns {LWWMap}
   */
  merge(other) {
    const merged = new LWWMap();
    const otherEntries = other.state();

    // All keys from this map
    for (const [key, reg] of this.#entries) {
      const otherReg = otherEntries.get(key);
      if (otherReg) {
        merged.#entries.set(key, reg.merge(otherReg));
      } else {
        const s = reg.state();
        merged.#entries.set(key, new LWWRegister(s.value, s.timestamp, s.nodeId));
      }
    }

    // Keys only in other
    for (const [key, reg] of otherEntries) {
      if (!this.#entries.has(key)) {
        const s = reg.state();
        merged.#entries.set(key, new LWWRegister(s.value, s.timestamp, s.nodeId));
      }
    }

    return merged;
  }

  /** @returns {IterableIterator<string>} Live keys */
  *keys() {
    for (const [key, reg] of this.#entries) {
      if (reg.value !== TOMBSTONE) yield key;
    }
  }

  /** @returns {IterableIterator<*>} Live values */
  *values() {
    for (const reg of this.#entries.values()) {
      if (reg.value !== TOMBSTONE) yield reg.value;
    }
  }

  /** @returns {IterableIterator<[string, *]>} Live entries */
  *entries() {
    for (const [key, reg] of this.#entries) {
      if (reg.value !== TOMBSTONE) yield [key, reg.value];
    }
  }

  /**
   * @returns {Map<string, LWWRegister>} Copy of internal entries
   */
  state() {
    return new Map(this.#entries);
  }

  toJSON() {
    const entries = {};
    for (const [key, reg] of this.#entries) {
      const s = reg.state();
      entries[key] = {
        value: s.value === TOMBSTONE ? null : s.value,
        timestamp: s.timestamp,
        nodeId: s.nodeId,
        tombstone: s.value === TOMBSTONE,
      };
    }
    return { entries };
  }

  /**
   * @param {{ entries: Record<string, { value: *, timestamp: number, nodeId: string, tombstone?: boolean }> }} data
   * @returns {LWWMap}
   */
  static fromJSON(data) {
    const map = new LWWMap();
    for (const [key, entry] of Object.entries(data.entries)) {
      const value = entry.tombstone ? TOMBSTONE : entry.value;
      map.#entries.set(key, new LWWRegister(value, entry.timestamp, entry.nodeId));
    }
    return map;
  }
}
