/**
 * ResourceTable — handle-based resource management.
 *
 * Provides a capability-secure resource table where every resource is accessed
 * through an opaque string handle (`res_N`). Supports typed lookups, ownership
 * transfer, and bounded capacity with TOCTOU-safe allocation.
 *
 * @module resource-table
 */

import { KERNEL_DEFAULTS } from './constants.mjs';
import { HandleNotFoundError, HandleTypeMismatchError, TableFullError } from './errors.mjs';

/**
 * A bounded, handle-keyed resource table with ownership tracking.
 */
export class ResourceTable {
  #entries = new Map();
  #counter = 0;
  #maxSize;

  /**
   * @param {Object} [opts={}]
   * @param {number} [opts.maxSize=4096] - Maximum number of entries.
   */
  constructor({ maxSize = KERNEL_DEFAULTS.MAX_RESOURCE_TABLE_SIZE } = {}) {
    this.#maxSize = maxSize;
  }

  /**
   * Allocate a new handle for a resource.
   *
   * @param {string} type - Resource type tag (e.g. `'stream'`, `'port'`, `'socket'`).
   * @param {*} value - The resource value.
   * @param {string} owner - Owner identifier (e.g. tenant ID).
   * @returns {string} The allocated handle (e.g. `'res_1'`).
   * @throws {TableFullError} If the table is at maximum capacity.
   */
  allocate(type, value, owner) {
    // TOCTOU-safe: check size immediately before insert
    if (this.#entries.size >= this.#maxSize) {
      throw new TableFullError(this.#maxSize);
    }
    const handle = `res_${++this.#counter}`;
    this.#entries.set(handle, { type, value, owner });
    return handle;
  }

  /**
   * Get a resource entry by handle.
   *
   * @param {string} handle - The resource handle.
   * @returns {{ type: string, value: *, owner: string }} The resource entry.
   * @throws {HandleNotFoundError} If the handle does not exist.
   */
  get(handle) {
    const entry = this.#entries.get(handle);
    if (!entry) throw new HandleNotFoundError(handle);
    return { type: entry.type, value: entry.value, owner: entry.owner };
  }

  /**
   * Get a resource value by handle, verifying the expected type.
   *
   * @param {string} handle - The resource handle.
   * @param {string} type - The expected resource type.
   * @returns {*} The resource value.
   * @throws {HandleNotFoundError} If the handle does not exist.
   * @throws {HandleTypeMismatchError} If the resource type does not match.
   */
  getTyped(handle, type) {
    const entry = this.get(handle);
    if (entry.type !== type) {
      throw new HandleTypeMismatchError(handle, type, entry.type);
    }
    return entry.value;
  }

  /**
   * Transfer ownership of a resource to a new owner.
   *
   * @param {string} handle - The resource handle.
   * @param {string} newOwner - The new owner identifier.
   * @throws {HandleNotFoundError} If the handle does not exist.
   */
  transfer(handle, newOwner) {
    const entry = this.#entries.get(handle);
    if (!entry) throw new HandleNotFoundError(handle);
    entry.owner = newOwner;
  }

  /**
   * Drop (remove) a resource from the table.
   *
   * @param {string} handle - The resource handle to drop.
   * @returns {*} The resource value that was removed.
   * @throws {HandleNotFoundError} If the handle does not exist.
   */
  drop(handle) {
    const entry = this.#entries.get(handle);
    if (!entry) throw new HandleNotFoundError(handle);
    this.#entries.delete(handle);
    return entry.value;
  }

  /**
   * Check whether a handle exists in the table.
   *
   * @param {string} handle - The resource handle.
   * @returns {boolean}
   */
  has(handle) {
    return this.#entries.has(handle);
  }

  /**
   * List all handles owned by a given owner.
   *
   * @param {string} owner - The owner identifier.
   * @returns {string[]} Array of handles owned by the owner.
   */
  listByOwner(owner) {
    const result = [];
    for (const [handle, entry] of this.#entries) {
      if (entry.owner === owner) result.push(handle);
    }
    return result;
  }

  /**
   * List all handles of a given type.
   *
   * @param {string} type - The resource type tag.
   * @returns {string[]} Array of handles of the given type.
   */
  listByType(type) {
    const result = [];
    for (const [handle, entry] of this.#entries) {
      if (entry.type === type) result.push(handle);
    }
    return result;
  }

  /**
   * List all handles in the table.
   *
   * @returns {string[]} Array of all allocated handles.
   */
  listAll() {
    return [...this.#entries.keys()];
  }

  /** Current number of entries. */
  get size() {
    return this.#entries.size;
  }

  /**
   * Remove all entries from the table.
   */
  clear() {
    this.#entries.clear();
  }
}
