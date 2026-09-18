/**
 * scheduler.mjs -- priority queues with a weighted-fair-queueing drain
 * order and a real anti-starvation bound.
 *
 * Borrows its scheduling *idea* (not its wire protocol) from Homa
 * (Ousterhout et al., Stanford): prioritize short messages so they don't
 * queue behind long ones, but bound how long any tier can be starved.
 *
 * Tiers drain in strict priority order (highest non-empty tier first) on
 * every slot *except* one slot in every `starvationGuardInterval`, which
 * is reserved unconditionally for the lowest non-empty tier -- regardless
 * of how much backlog sits in higher tiers. That gives a concrete,
 * testable bound: any single item sitting alone in the lowest tier is
 * dequeued within `starvationGuardInterval` `dequeue()` calls, no matter
 * how continuously higher tiers are fed.
 */

/** Default tier order, highest priority first. */
export const DEFAULT_TIERS = Object.freeze(['high', 'normal', 'low']);

/** Default anti-starvation guard: 1 in every 8 drain slots is reserved. */
export const DEFAULT_STARVATION_GUARD_INTERVAL = 8;

export class PriorityScheduler {
  /**
   * @param {object} [opts]
   * @param {string[]} [opts.tiers] - Tier names, highest priority first.
   * @param {number} [opts.starvationGuardInterval] - Every Nth `dequeue()`
   *   call is forced to serve the lowest non-empty tier regardless of
   *   backlog elsewhere. Must be >= 1. Set to `Infinity` to disable (pure
   *   strict priority, no starvation guard -- not recommended).
   */
  constructor(opts = {}) {
    this.tiers = opts.tiers || DEFAULT_TIERS;
    if (this.tiers.length === 0) throw new Error('priority-mux: scheduler needs at least one tier');
    this.starvationGuardInterval = opts.starvationGuardInterval ?? DEFAULT_STARVATION_GUARD_INTERVAL;
    if (this.starvationGuardInterval < 1) {
      throw new Error('priority-mux: starvationGuardInterval must be >= 1');
    }
    this.queues = new Map(this.tiers.map((t) => [t, []]));
    this.slotCounter = 0;
  }

  /**
   * Enqueue one item under a given tier.
   * @param {string} tier
   * @param {*} item
   */
  enqueue(tier, item) {
    const q = this.queues.get(tier);
    if (!q) throw new Error(`priority-mux: unknown tier "${tier}"`);
    q.push(item);
  }

  /** Total number of items queued across all tiers. */
  get size() {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  /** Size of a single tier's queue. */
  sizeOf(tier) {
    const q = this.queues.get(tier);
    return q ? q.length : 0;
  }

  /**
   * Pop the next item to send, or `undefined` if every queue is empty.
   * Advances the internal slot counter (used by the starvation guard) on
   * every call, including calls that find nothing to dequeue -- so the
   * guard period is measured in *drain attempts*, matching how a real
   * drain loop calls this once per tick.
   * @returns {*|undefined}
   */
  dequeue() {
    this.slotCounter++;

    const isGuardSlot = Number.isFinite(this.starvationGuardInterval)
      && this.slotCounter % this.starvationGuardInterval === 0;

    if (isGuardSlot) {
      // Anti-starvation: scan from the *lowest*-priority tier up, and
      // serve the first non-empty one, ignoring higher-tier backlog.
      for (let i = this.tiers.length - 1; i >= 0; i--) {
        const q = this.queues.get(this.tiers[i]);
        if (q.length) return q.shift();
      }
      return undefined; // everything empty -- fall through is unreachable
    }

    // Strict priority: highest non-empty tier wins.
    for (const tier of this.tiers) {
      const q = this.queues.get(tier);
      if (q.length) return q.shift();
    }
    return undefined;
  }
}
