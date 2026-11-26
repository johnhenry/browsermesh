// Monotonic checks. `PeerRegistry` replaces grants by (realm, peer, role) and does not order serials, so this package
// refuses a credential older than what the verifier already holds. Serials are per issuing ledger, so the key includes
// the issuer.
import { MAX_TRACKER_ENTRIES, MAX_SKEW } from "./limits.mjs";
import { resolveNow } from "./keys.mjs";

/**
 * @param {{ maxEntries?: number }} [opts]
 */
export function createCredentialTracker({ maxEntries = MAX_TRACKER_ENTRIES } = {}) {
  /** @type {Map<string, { serial: number, notAfter: number }>} */
  const held = new Map();
  /** @type {Map<string, number>} */
  const epochs = new Map();

  const keyOf = (c) => `${c.realm}|${c.issuer}|${c.subject}|${c.role}`;
  const expired = (e, now) => e.notAfter + MAX_SKEW < now;

  function evict(now) {
    for (const [k, e] of held) if (expired(e, now)) held.delete(k);
  }

  function inspect(verified, opts) {
    if (!verified || verified.ok !== true || !verified.credential) return { ok: false, reason: "unverified" };
    const c = verified.credential;
    const e = epochs.get(c.realm);
    if (e !== undefined && c.epoch < e) return { ok: false, reason: "epoch-too-old" };
    const h = held.get(keyOf(c));
    if (h && c.serial < h.serial) return { ok: false, reason: "stale-serial" };
    if (!h && held.size >= maxEntries) {
      const now = resolveNow(opts?.now);
      let room = false;
      for (const x of held.values()) if (expired(x, now)) { room = true; break; }
      if (!room) return { ok: false, reason: "tracker-full" };
    }
    return { ok: true };
  }

  return {
    /** Record that a realm's descriptor (or any trusted source) reached this epoch. Never lowers it. */
    noteEpoch(realm, epoch) {
      if (Number.isSafeInteger(epoch) && epoch > (epochs.get(realm) ?? -1)) epochs.set(realm, epoch);
    },
    epochOf(realm) {
      return epochs.get(realm);
    },
    /** Would this verified credential be admitted? (No state change.) */
    check(verified, opts) {
      return inspect(verified, opts);
    },
    /** Check, and on success remember the serial. */
    admit(verified, opts) {
      const r = inspect(verified, opts);
      if (!r.ok) return r;
      const c = verified.credential;
      const k = keyOf(c);
      if (!held.has(k) && held.size >= maxEntries) evict(resolveNow(opts?.now));
      held.set(k, { serial: c.serial, notAfter: verified.effective?.notAfter ?? c.notAfter });
      return { ok: true };
    },
    get size() {
      return held.size;
    },
  };
}
