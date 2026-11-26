import { fail } from "./errors.mjs";
import { MAX_TIME } from "./limits.mjs";

export const isPlainObject = (v) => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

export const isInt = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
export const isTime = (v) => isInt(v, 0, MAX_TIME);

/** Reject any key outside `required` + `optional`, and any missing required key. */
export function exactKeys(obj, required, optional, what) {
  if (!isPlainObject(obj)) fail("malformed", `${what} must be an object`);
  for (const k of Object.keys(obj)) {
    if (!required.includes(k) && !optional.includes(k)) fail("malformed", `${what}: unknown field ${JSON.stringify(k)}`);
  }
  for (const k of required) if (!(k in obj)) fail("malformed", `${what}: missing field ${k}`);
}

export function need(cond, detail) {
  if (!cond) fail("malformed", detail);
}

export const utf8Length = (s) => new TextEncoder().encode(s).length;

export const hasControl = (s) => /[\u0000-\u001f\u007f]/.test(s);
