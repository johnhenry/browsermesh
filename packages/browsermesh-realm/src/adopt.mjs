// Adoption (docs/design/realms.md 5.2): a descriptor offered by any peer is adopted only after it verifies end to end
// against the pinned id and the rotation chain AND its serial is strictly higher than the held one. It never throws on
// hostile input; the verifier caps size and chain length, so a peer announcing a high serial buys bounded work.
import { guard, fail } from "./errors.mjs";
import { verifyDescriptor } from "./descriptor.mjs";
import { isPlainObject, need } from "./validate.mjs";

/**
 * @param {object | null | undefined} held the verified descriptor object currently held (or none)
 * @param {unknown} offered the offered descriptor text
 * @param {{ pinnedId: string, now?: number | (() => number), maxBytes?: number, maxChain?: number }} opts
 * @returns {Promise<{ ok: true, descriptor: object, text: string, chainLength: number } | { ok: false, reason: string, detail?: string }>}
 */
export function adoptDescriptor(held, offered, opts) {
  return guard(async () => {
    const { pinnedId, now, maxBytes, maxChain } = opts ?? {};
    need(typeof pinnedId === "string", "adoptDescriptor needs a pinnedId");
    const have = held === null || held === undefined ? null : held;
    if (have !== null) {
      const root = have.root;
      if (!isPlainObject(have) || have.id !== pinnedId || !isPlainObject(root) || !Array.isArray(root.chain)
        || !Number.isSafeInteger(have.serial) || !Number.isSafeInteger(have.epoch)) {
        fail("held-mismatch", "the held descriptor is not a verified descriptor for the pinned id");
      }
    }
    const v = await verifyDescriptor(offered, { pinnedId, now, maxBytes, maxChain, heldChain: have?.root.chain });
    if (!v.ok) return v;
    if (have !== null) {
      if (v.descriptor.serial <= have.serial) fail("stale-serial", "serial is not higher than the one held");
      if (v.descriptor.epoch < have.epoch) fail("epoch-regressed", "epoch is lower than the one held");
    }
    return v;
  });
}
