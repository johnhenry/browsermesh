// The realm exchange's frames (docs/design/realms.md 5.5). Each is a JSON object with a `t` type string and a few small
// fields. Every field is checked and every size is capped: a peer cannot make the parser, or what comes after it, do
// unbounded work.
//
//   t                       fields                                  who sends it            meaning
//   realm:hello             id, serial, epoch                       both                    "this is the realm I speak, and the descriptor I hold"
//                                                                                           (serial 0 = none held)
//   realm:need-descriptor   have                                    the side that is behind "send me yours; I hold serial `have`"
//   realm:descriptor        text                                    the side that is ahead  the exact canonical descriptor text (<= 16 KiB)
//   realm:credential        text | null                             the prover              its credential (<= 2 KiB); null = "no credential,
//                                                                                           give me the open-mode default role"
//   realm:result            ok, reason?, role?, notAfter?           the verifier            the verdict; `notAfter` is whole seconds
//
// A frame may arrive as an object or as JSON text (wsh delivers text); `parseFrame` accepts both.
import { MAX_DESCRIPTOR_BYTES, MAX_CREDENTIAL_BYTES, MAX_TIME } from "./limits.mjs";
import { isPlainObject, isInt, utf8Length } from "./validate.mjs";
import { isRoleName } from "./roles.mjs";

export const FRAME_TYPES = Object.freeze([
  "realm:hello", "realm:need-descriptor", "realm:descriptor", "realm:credential", "realm:result",
]);

/** A descriptor's JSON escaping can at most double it, so a `realm:descriptor` frame is under this. */
export const MAX_FRAME_BYTES = 2 * MAX_DESCRIPTOR_BYTES + 256;
/**
 * The smallest `maxFrameBytes` a host's link-admission seam may be configured with if it is to carry descriptors. The seam's
 * default (16 KiB) silently drops a larger descriptor frame; small descriptors still pass.
 */
export const MIN_SEAM_FRAME_BYTES = 2 * MAX_DESCRIPTOR_BYTES + 1024;

const MAX_ID = 64;
const MAX_REASON = 64;
const ID = /^[A-Za-z0-9_-]+$/;
const REASON = /^[a-z0-9:-]+$/;

const SPEC = {
  "realm:hello": { required: ["t", "id", "serial", "epoch"], optional: [], check: (f) =>
    typeof f.id === "string" && f.id.length >= 1 && f.id.length <= MAX_ID && ID.test(f.id) && isInt(f.serial) && isInt(f.epoch) },
  "realm:need-descriptor": { required: ["t", "have"], optional: [], check: (f) => isInt(f.have) },
  "realm:descriptor": { required: ["t", "text"], optional: [], check: (f) =>
    typeof f.text === "string" && utf8Length(f.text) <= MAX_DESCRIPTOR_BYTES },
  "realm:credential": { required: ["t", "text"], optional: [], check: (f) =>
    f.text === null || (typeof f.text === "string" && utf8Length(f.text) <= MAX_CREDENTIAL_BYTES) },
  "realm:result": { required: ["t", "ok"], optional: ["reason", "role", "notAfter"], check: (f) =>
    typeof f.ok === "boolean"
    && (f.reason === undefined || (typeof f.reason === "string" && f.reason.length <= MAX_REASON && REASON.test(f.reason)))
    && (f.role === undefined || isRoleName(f.role))
    && (f.notAfter === undefined || isInt(f.notAfter, 0, MAX_TIME)) },
};

const bad = (realm) => ({ ok: false, reason: "bad-frame", realm });

/**
 * Parse and validate one frame. Never throws.
 * @param {unknown} raw an object, or JSON text of one
 * @returns {{ ok: true, frame: object } | { ok: false, reason: "bad-frame", realm: boolean }}
 *   `realm` is true when the input at least claims a `realm:` type (so a caller can ignore foreign traffic but refuse a
 *   malformed realm frame).
 */
export function parseFrame(raw) {
  let f = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_FRAME_BYTES) return bad(false);
    try { f = JSON.parse(raw); } catch { return bad(false); }
  }
  if (!isPlainObject(f) || typeof f.t !== "string") return bad(false);
  const realm = f.t.startsWith("realm:");
  const spec = Object.hasOwn(SPEC, f.t) ? SPEC[f.t] : null;
  if (!spec) return bad(realm);
  for (const k of Object.keys(f)) if (!spec.required.includes(k) && !spec.optional.includes(k)) return bad(realm);
  for (const k of spec.required) if (!(k in f)) return bad(realm);
  if (!spec.check(f)) return bad(realm);
  return { ok: true, frame: f };
}
