// The descriptor store (docs/design/realms.md 5.2 and 5.5): the one place a realm descriptor is held, offered and adopted.
//
// A peer announcing a high serial must not be able to cost more than a bounded amount of work, so an offer is gated
// before it is verified: size, then (only when something is held) a cheap JSON read of the serial, then a per-link and a
// global rate limit. Only then is the full verification (`adoptDescriptor`: canonical parse, chain, signature) run, and
// only the verified, strictly higher descriptor replaces the held one. Offers are serialised, so two links racing each
// other cannot adopt out of order.
import { adoptDescriptor } from "./adopt.mjs";
import { verifyDescriptor } from "./descriptor.mjs";
import { MAX_DESCRIPTOR_BYTES } from "./limits.mjs";
import { resolveNow } from "./keys.mjs";
import { need, utf8Length } from "./validate.mjs";

const DEFAULTS = Object.freeze({
  maxBytes: MAX_DESCRIPTOR_BYTES,
  /** Offers one link may make (verified or not). */
  maxOffersPerLink: 4,
  /** Offers one link may have fully verified. */
  maxVerifiesPerLink: 2,
  /** Full verifications across all links within `windowSeconds`. */
  maxVerifiesPerWindow: 16,
  windowSeconds: 60,
  /** Links whose counters are remembered at once (oldest forgotten first). */
  maxLinks: 1024,
});

/**
 * @param {object} opts
 * @param {string} opts.pinnedId the realm id this store is for
 * @param {string} [opts.held] a descriptor text to start from (the baked one, or an earlier `export()`); verified before it
 *   counts, so a bad one leaves the store empty
 * @param {unknown[]} [opts.heldChain] a rotation chain already seen, pinned while no descriptor is held
 * @param {number | (() => number)} [opts.now] whole seconds
 * @param {Partial<typeof DEFAULTS>} [opts.limits]
 * @param {(descriptor: object, previous: object | null) => void} [opts.onAdopt]
 */
export function createDescriptorStore({ pinnedId, held, heldChain, now, limits, onAdopt } = {}) {
  need(typeof pinnedId === "string" && pinnedId !== "", "createDescriptorStore needs a pinnedId");
  const L = { ...DEFAULTS, ...limits };
  let current = null;
  let currentText = null;
  const listeners = new Set();
  if (typeof onAdopt === "function") listeners.add(onAdopt);
  const stats = { verifies: 0, adopted: 0, rejected: 0 };
  /** @type {Map<unknown, { offers: number, verifies: number }>} */
  const links = new Map();
  /** @type {number[]} */
  const window = [];
  let queue = Promise.resolve();

  const ready = (async () => {
    if (held === undefined || held === null) return { ok: true };
    const v = await verifyDescriptor(held, { pinnedId, now, maxBytes: L.maxBytes, heldChain });
    if (!v.ok) return v;
    current = v.descriptor;
    currentText = v.text;
    return { ok: true };
  })();

  function linkEntry(linkId) {
    let e = links.get(linkId);
    if (!e) {
      if (links.size >= L.maxLinks) links.delete(links.keys().next().value);
      e = { offers: 0, verifies: 0 };
      links.set(linkId, e);
    }
    return e;
  }

  const reject = (reason, detail) => {
    stats.rejected++;
    return { ok: false, reason, ...(detail ? { detail } : {}) };
  };

  async function run(text, linkId) {
    await ready;
    if (typeof text !== "string") return reject("malformed", "a descriptor is text");
    if (utf8Length(text) > L.maxBytes) return reject("too-large", "descriptor is too large");
    const entry = linkEntry(linkId);
    if (++entry.offers > L.maxOffersPerLink) return reject("rate-limited", "too many offers on this link");
    if (current) {
      // A cheap read: only a serial above ours is worth an Ed25519 verification.
      let serial;
      try { serial = JSON.parse(text)?.serial; } catch { return reject("malformed", "not JSON"); }
      if (!Number.isSafeInteger(serial)) return reject("malformed", "no serial");
      if (serial <= current.serial) return reject("stale-serial", "serial is not higher than the one held");
    }
    if (entry.verifies >= L.maxVerifiesPerLink) return reject("rate-limited", "too many verifications on this link");
    const t = resolveNow(now);
    while (window.length && window[0] <= t - L.windowSeconds) window.shift();
    if (window.length >= L.maxVerifiesPerWindow) return reject("rate-limited", "too many verifications");
    window.push(t);
    entry.verifies++;
    stats.verifies++;

    const opts = { pinnedId, now, maxBytes: L.maxBytes };
    const v = current ? await adoptDescriptor(current, text, opts) : await verifyDescriptor(text, { ...opts, heldChain });
    if (!v.ok) return reject(v.reason, v.detail);
    const previous = current;
    current = v.descriptor;
    currentText = v.text;
    stats.adopted++;
    for (const fn of [...listeners]) {
      try { fn(current, previous); } catch { /* a listener may not break adoption */ }
    }
    return { ok: true, adopted: true, descriptor: current, text: currentText };
  }

  return {
    /** Resolves `{ ok }` once the `held` descriptor has been checked. */
    ready,
    /** The verified descriptor held now, or null. */
    current: () => current,
    /** Its exact canonical text (what to persist, and to send to a peer that asks), or null. Feed it back as `held`. */
    export: () => currentText,
    /**
     * Offer a descriptor from a peer. Adopted only if it verifies end to end and its serial is higher; never throws.
     * @param {unknown} text
     * @param {{ linkId?: unknown }} [o] the link it came from, for the per-link limits
     */
    offer(text, { linkId = "anonymous" } = {}) {
      const result = queue.then(() => run(text, linkId));
      queue = result.then(() => undefined, () => undefined);
      return result.catch(() => reject("malformed", "unexpected input"));
    },
    /** Subscribe to adoptions. Returns the unsubscribe function. */
    onAdopt(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Free a link's counters (call when the link ends). */
    forget(linkId) {
      links.delete(linkId);
    },
    stats: () => ({ ...stats, links: links.size }),
  };
}
