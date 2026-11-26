/**
 * Strict canonical JSON (docs/design/realms.md, section 5.2, "Canonical
 * profile").
 *
 * The same bytes must verify in every language, so the profile is narrow:
 *
 *  - Values: `null`, booleans, safe integers (|n| <= 2^53-1), strings, arrays,
 *    plain objects. No floats, `-0`, bigint, undefined, functions, Dates or
 *    byte arrays (callers pass bytes as base64url strings).
 *  - Object keys are ASCII, sorted by code unit (equal to code point order for
 *    ASCII), and cannot repeat. No whitespace anywhere.
 *  - Strings are well-formed Unicode (no lone surrogates) and written as raw
 *    UTF-8 with no normalisation. Only `"`, `\` and U+0000..U+001F are escaped:
 *    `\"`, `\\` and `\u00xx` with lowercase hex. There are no short escapes
 *    (`\n`) and no `\/`.
 *
 * `parseCanonical` is a purpose-built parser, not `JSON.parse` (which collapses
 * duplicate keys and rounds large integers), and accepts only text that is
 * byte-identical to `canonicalJson` of its own result.
 *
 * `domainSigningBytes` builds what is actually signed: UTF-8(domain) || 0x00 ||
 * UTF-8(text), so a signature over one object type never verifies as another.
 */

export const CANONICAL_MAX_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_DEPTH = 64;

/**
 * Error codes (stable): `unsupported-type`, `number-not-integer`,
 * `negative-zero`, `integer-out-of-range`, `leading-zero`, `key-not-ascii`,
 * `duplicate-key`, `lone-surrogate`, `whitespace`, `not-canonical`, `depth`,
 * `syntax`, `bad-domain`.
 */
export class CanonicalJsonError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "CanonicalJsonError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new CanonicalJsonError(code, message);
}

const isAscii = (s) => /^[\x00-\x7f]*$/.test(s);

function hex4(n) {
  return n.toString(16).padStart(4, "0");
}

function encodeString(s) {
  if (!s.isWellFormed()) fail("lone-surrogate", "string contains a lone surrogate");
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c < 0x20) out += "\\u" + hex4(c);
    else out += s[i];
  }
  return out + '"';
}

function encode(value, depth) {
  if (depth > MAX_DEPTH) fail("depth", `nesting deeper than ${MAX_DEPTH}`);
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return encodeString(value);
    case "number":
      if (Object.is(value, -0)) fail("negative-zero", "-0 is not allowed");
      if (!Number.isInteger(value)) fail("number-not-integer", "only integers are allowed");
      if (Math.abs(value) > CANONICAL_MAX_INTEGER) {
        fail("integer-out-of-range", "integer magnitude exceeds 2^53-1");
      }
      return String(value);
    case "object":
      break;
    default:
      fail("unsupported-type", `unsupported type: ${typeof value}`);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      fail("unsupported-type", "array subclass");
    }
    const parts = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) fail("unsupported-type", "sparse array");
      parts.push(encode(value[i], depth + 1));
    }
    return "[" + parts.join(",") + "]";
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail("unsupported-type", "only plain objects are allowed");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail("unsupported-type", "symbol keys are not allowed");
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    if (!isAscii(k)) fail("key-not-ascii", "object keys must be ASCII");
    parts.push(encodeString(k) + ":" + encode(value[k], depth + 1));
  }
  return "{" + parts.join(",") + "}";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return encode(value, 0);
}

const WS = new Set([" ", "\t", "\n", "\r"]);

class Parser {
  constructor(text) {
    this.t = text;
    this.i = 0;
  }

  peek() {
    return this.t[this.i];
  }

  unexpected() {
    if (this.i >= this.t.length) fail("syntax", "unexpected end of input");
    if (WS.has(this.t[this.i])) fail("whitespace", "whitespace is not allowed");
    fail("syntax", `unexpected character at ${this.i}`);
  }

  value(depth) {
    if (depth > MAX_DEPTH) fail("depth", `nesting deeper than ${MAX_DEPTH}`);
    const c = this.peek();
    if (c === "{") return this.object(depth);
    if (c === "[") return this.array(depth);
    if (c === '"') return this.string(false);
    if (c === "-" || (c >= "0" && c <= "9")) return this.number();
    for (const [lit, val] of [["null", null], ["true", true], ["false", false]]) {
      if (this.t.startsWith(lit, this.i)) {
        this.i += lit.length;
        return val;
      }
    }
    return this.unexpected();
  }

  number() {
    const start = this.i;
    let neg = false;
    if (this.peek() === "-") {
      neg = true;
      this.i++;
    }
    const dStart = this.i;
    while (this.peek() >= "0" && this.peek() <= "9") this.i++;
    const digits = this.t.slice(dStart, this.i);
    if (digits === "") this.unexpected();
    const next = this.peek();
    if (next === "." || next === "e" || next === "E") {
      fail("number-not-integer", "floats and exponents are not allowed");
    }
    if (digits.length > 1 && digits[0] === "0") fail("leading-zero", "leading zero");
    if (neg && digits === "0") fail("negative-zero", "-0 is not allowed");
    if (BigInt(digits) > BigInt(CANONICAL_MAX_INTEGER)) {
      fail("integer-out-of-range", "integer magnitude exceeds 2^53-1");
    }
    return Number(this.t.slice(start, this.i));
  }

  string(isKey) {
    this.i++; // opening quote
    let out = "";
    for (;;) {
      if (this.i >= this.t.length) fail("syntax", "unterminated string");
      const code = this.t.charCodeAt(this.i);
      const ch = this.t[this.i];
      if (ch === '"') {
        this.i++;
        break;
      }
      if (ch === "\\") {
        out += this.escape(isKey);
        continue;
      }
      if (code < 0x20) fail("syntax", "raw control character in string");
      if (code >= 0xd800 && code <= 0xdbff) {
        const lo = this.t.charCodeAt(this.i + 1);
        if (!(lo >= 0xdc00 && lo <= 0xdfff)) fail("lone-surrogate", "lone surrogate");
        out += ch + this.t[this.i + 1];
        this.i += 2;
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) fail("lone-surrogate", "lone surrogate");
      out += ch;
      this.i++;
    }
    if (isKey && !isAscii(out)) fail("key-not-ascii", "object keys must be ASCII");
    return out;
  }

  escape(isKey) {
    const e = this.t[this.i + 1];
    if (e === '"' || e === "\\") {
      this.i += 2;
      return e;
    }
    if (e === "u") {
      const h = this.t.slice(this.i + 2, this.i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(h)) fail("syntax", "bad \\u escape");
      const n = parseInt(h, 16);
      if (n >= 0xd800 && n <= 0xdfff) fail("lone-surrogate", "escaped surrogate");
      if (isKey && n > 0x7f) fail("key-not-ascii", "object keys must be ASCII");
      if (n >= 0x20 || h !== hex4(n)) {
        fail("not-canonical", "escape is not the canonical form");
      }
      this.i += 6;
      return String.fromCharCode(n);
    }
    if ('bfnrt/'.includes(e ?? "")) fail("not-canonical", "short escape is not canonical");
    return fail("syntax", "unknown escape");
  }

  array(depth) {
    this.i++;
    const out = [];
    if (this.peek() === "]") {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value(depth + 1));
      const c = this.peek();
      if (c === ",") this.i++;
      else if (c === "]") {
        this.i++;
        return out;
      } else this.unexpected();
    }
  }

  object(depth) {
    this.i++;
    const out = {};
    if (this.peek() === "}") {
      this.i++;
      return out;
    }
    const seen = new Set();
    let prev = null;
    for (;;) {
      if (this.peek() !== '"') this.unexpected();
      const key = this.string(true);
      if (seen.has(key)) fail("duplicate-key", `duplicate key ${JSON.stringify(key)}`);
      if (prev !== null && key < prev) fail("not-canonical", "keys are not sorted");
      seen.add(key);
      prev = key;
      if (this.peek() !== ":") this.unexpected();
      this.i++;
      const v = this.value(depth + 1);
      Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
      const c = this.peek();
      if (c === ",") this.i++;
      else if (c === "}") {
        this.i++;
        return out;
      } else this.unexpected();
    }
  }
}

/**
 * Parse text that is already in canonical form; throw `CanonicalJsonError`
 * (with a stable `code`) for anything else.
 * @param {string} text
 * @returns {unknown}
 */
export function parseCanonical(text) {
  if (typeof text !== "string") fail("syntax", "input must be a string");
  const p = new Parser(text);
  const value = p.value(0);
  if (p.i < text.length) p.unexpected();
  if (canonicalJson(value) !== text) fail("not-canonical", "input is not in canonical form");
  return value;
}

/**
 * The bytes a signature covers: UTF-8(domain) || 0x00 || UTF-8(text).
 * `domain` is non-empty printable ASCII (0x21..0x7e, so no NUL, space or
 * control characters); `text` is canonical text (not re-validated here).
 * @param {string} domain
 * @param {string} canonicalText
 * @returns {Uint8Array}
 */
export function domainSigningBytes(domain, canonicalText) {
  if (typeof domain !== "string" || !/^[\x21-\x7e]+$/.test(domain)) {
    fail("bad-domain", "domain must be non-empty printable ASCII with no spaces or NUL");
  }
  if (typeof canonicalText !== "string") fail("syntax", "text must be a string");
  if (!canonicalText.isWellFormed()) fail("lone-surrogate", "text contains a lone surrogate");
  const enc = new TextEncoder();
  const d = enc.encode(domain);
  const t = enc.encode(canonicalText);
  const out = new Uint8Array(d.length + 1 + t.length);
  out.set(d, 0);
  out[d.length] = 0;
  out.set(t, d.length + 1);
  return out;
}
