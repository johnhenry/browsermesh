// The issuer ledger (docs/design/realms.md 5.8): an in-memory, append-only record of every credential an issuer has
// allocated a serial for. The serials are what `descriptor.revoked` refers to. No file I/O: `export()` returns text
// and `importLedger(text)` reads it back, so the caller decides where it lives.
//
// Serials are per ledger. `descriptor.revoked` is a flat list of serials with no issuer, so a realm with several
// issuers must give each ledger a disjoint range (`serialStart`) or share one ledger.
import { canonicalJson, parseCanonical } from "@johnhenry/browsermesh-primitives";
import { fail, toRealmError } from "./errors.mjs";
import { MAX_LEDGER_ENTRIES, MAX_LEDGER_BYTES, MAX_REVOKED, MAX_SKEW } from "./limits.mjs";
import { isKey } from "./keys.mjs";
import { isRoleName } from "./roles.mjs";
import { exactKeys, isInt, isPlainObject, isTime, need, utf8Length } from "./validate.mjs";

const STATES = new Set(["issued", "revoked"]);

function checkEntryFields(e) {
  need(isPlainObject(e), "entry must be an object");
  need(isKey(e.subject), "entry.subject must be a key");
  need(isRoleName(e.role), "entry.role is not a role name");
  need(isTime(e.notAfter), "entry.notAfter must be whole seconds");
}

function wrap(fn) {
  try {
    return fn();
  } catch (err) {
    throw toRealmError(err);
  }
}

function build({ maxEntries, nextSerial, entries }) {
  /** @type {Map<number, Readonly<{ serial: number, subject: string, role: string, notAfter: number, state: string }>>} */
  const map = new Map(entries.map((e) => [e.serial, Object.freeze({ ...e })]));
  let next = nextSerial;

  return {
    /**
     * Allocate the next serial and record the credential about to be issued.
     * @param {{ subject: string, role: string, notAfter: number }} fields
     */
    allocate(fields) {
      return wrap(() => {
        checkEntryFields(fields);
        if (map.size >= maxEntries) fail("ledger-full", `ledger holds ${maxEntries} entries; compact() or start a new one`);
        if (next > Number.MAX_SAFE_INTEGER) fail("ledger-full", "serial space exhausted");
        const entry = Object.freeze({ serial: next, subject: fields.subject, role: fields.role, notAfter: fields.notAfter, state: "issued" });
        map.set(entry.serial, entry);
        next += 1;
        return entry;
      });
    },

    /** The entry for a serial, or null. */
    get(serial) {
      return map.get(serial) ?? null;
    },

    /**
     * Mark a credential revoked (the only state change an entry ever has). Idempotent.
     * @returns {boolean} false when the serial is unknown
     */
    markRevoked(serial) {
      const e = map.get(serial);
      if (!e) return false;
      if (e.state !== "revoked") map.set(serial, Object.freeze({ ...e, state: "revoked" }));
      return true;
    },

    /** Entries in serial order, optionally only those in `state`. */
    list(opts) {
      const all = [...map.values()];
      return opts?.state ? all.filter((e) => e.state === opts.state) : all;
    },

    /**
     * The serials to put in `descriptor.revoked`: revoked credentials that could still be presented (a credential past
     * `notAfter` plus skew is refused anyway). Ascending. Throws `too-many-revoked` rather than drop one silently; the
     * answer then is to bump the epoch.
     */
    revokedSerials({ now, max = MAX_REVOKED, skew = MAX_SKEW }) {
      return wrap(() => {
        need(isInt(now, 0), "now must be whole seconds");
        const out = [...map.values()].filter((e) => e.state === "revoked" && e.notAfter + skew >= now).map((e) => e.serial);
        if (out.length > max) fail("too-many-revoked", `${out.length} live revocations exceed ${max}; bump the epoch instead`);
        return out;
      });
    },

    /**
     * Drop entries that can no longer matter (expired past skew). Serials are never reused. Returns how many went.
     */
    compact({ now, skew = MAX_SKEW }) {
      return wrap(() => {
        need(isInt(now, 0), "now must be whole seconds");
        let n = 0;
        for (const [serial, e] of map) {
          if (e.notAfter + skew < now) {
            map.delete(serial);
            n += 1;
          }
        }
        return n;
      });
    },

    get size() {
      return map.size;
    },

    get nextSerial() {
      return next;
    },

    /**
     * Canonical JSON text of the whole ledger.
     * @param {{ maxBytes?: number }} [opts]
     */
    export(opts) {
      return wrap(() => {
        const text = canonicalJson({ v: 1, next, entries: [...map.values()] });
        if (utf8Length(text) > (opts?.maxBytes ?? MAX_LEDGER_BYTES)) fail("too-large", "ledger export exceeds the size cap");
        return text;
      });
    },
  };
}

/**
 * @param {{ maxEntries?: number, serialStart?: number }} [opts] `serialStart` gives this ledger its own serial range
 */
export function createLedger(opts) {
  return wrap(() => {
    const { maxEntries = MAX_LEDGER_ENTRIES, serialStart = 1 } = opts ?? {};
    need(isInt(maxEntries, 1) && isInt(serialStart, 1), "bad ledger options");
    return build({ maxEntries, nextSerial: serialStart, entries: [] });
  });
}

/**
 * Read a ledger back from `export()` text. Refuses non-canonical, oversized, or inconsistent input.
 * @param {string} text
 * @param {{ maxBytes?: number, maxEntries?: number }} [opts]
 */
export function importLedger(text, opts) {
  return wrap(() => {
    const { maxBytes = MAX_LEDGER_BYTES, maxEntries = MAX_LEDGER_ENTRIES } = opts ?? {};
    if (typeof text !== "string") fail("malformed", "ledger must be text");
    if (utf8Length(text) > maxBytes) fail("too-large", "ledger text exceeds the size cap");
    const doc = parseCanonical(text);
    exactKeys(doc, ["v", "next", "entries"], [], "ledger");
    if (doc.v !== 1) fail("unsupported-version", "ledger version must be 1");
    need(isInt(doc.next, 1) && Array.isArray(doc.entries), "bad ledger header");
    if (doc.entries.length > maxEntries) fail("ledger-full", `ledger holds more than ${maxEntries} entries`);
    let prev = 0;
    for (const e of doc.entries) {
      exactKeys(e, ["serial", "subject", "role", "notAfter", "state"], [], "entry");
      checkEntryFields(e);
      need(isInt(e.serial, 1) && e.serial > prev && e.serial < doc.next, "serials must ascend and stay below next");
      need(STATES.has(e.state), "bad entry state");
      prev = e.serial;
    }
    return build({ maxEntries, nextSerial: doc.next, entries: doc.entries });
  });
}
