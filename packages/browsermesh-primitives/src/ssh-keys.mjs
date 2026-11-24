/**
 * ssh-keys.mjs -- one key in two worlds, explicitly.
 *
 * A pod id is `base64url(SHA-256(raw Ed25519 public key))`. wsh names the same
 * key by the same hash in hex (its "fingerprint"), and OpenSSH names it by the
 * key itself, in one line (`ssh-ed25519 AAAA...`). This module is the ONE
 * place in browsermesh that converts between them:
 *
 *   podIdToFingerprint(podId)  <->  fingerprintToPodId(hex)         the same 32 bytes, base64url and hex
 *   openSSHPublicKeyFromRaw(raw)  <->  rawPublicKeyFromOpenSSH(line)   the public key line
 *   podIdFromOpenSSHPublicKey(line)                                  the pod id of a public key line
 *   authorizedKeysLine({ rawPublicKey, capabilities, expires, comment })   a wsh/OpenSSH authorized_keys line
 *
 * Nothing here is called by default: no identity is ever written to, or read
 * from, an authorized_keys file, a key agent or the filesystem by this package.
 * What it does NOT do: parse an OpenSSH PRIVATE key (nothing in this repository
 * or in wsh does, and a private-key parser is not something to write for one
 * convenience); a private key crosses as PKCS#8 (`PodIdentity.fromPkcs8`,
 * `exportPrivateKey('pkcs8')`).
 *
 * The conversions are strict: a pod id and a fingerprint are exactly 32 bytes,
 * a public key line is exactly one `ssh-ed25519` key, base64 is canonical, and
 * a line that carries options or control characters is refused rather than cut
 * to what looks right. `@johnhenry/wsh` has the same conversions
 * (`fingerprintToPodId`, `podIdToFingerprint`, `exportPublicKeySSH`,
 * `parseSSHPublicKey`); a test checks the two agree on every valid input
 * (wsh is a development dependency of that test, not a dependency of this
 * package) and wsh is the more lenient of the two on malformed input.
 */
import { encodeBase64url, decodeBase64url } from './identity.mjs';
import { podIdFromRawKey } from './session.mjs';

const POD_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const HEX_FP_RE = /^[0-9a-fA-F]{64}$/;
const SSH_TYPE = 'ssh-ed25519';
const SSH_BLOB_BASE64_LENGTH = 68; // 4 + 11 + 4 + 32 = 51 bytes, no padding
const MAX_LINE_LENGTH = 4096;

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));

/**
 * pod id (base64url of SHA-256 of the raw key) to the wsh fingerprint (the same hash, in hex).
 * @param {string} podId
 * @returns {string} 64 lower-case hex characters
 */
export function podIdToFingerprint(podId) {
  if (typeof podId !== 'string' || !POD_ID_RE.test(podId)) throw new TypeError('podIdToFingerprint: expected a 43 character base64url pod id');
  const bytes = decodeBase64url(podId);
  if (bytes.length !== 32 || encodeBase64url(bytes) !== podId) throw new TypeError('podIdToFingerprint: a pod id is 32 bytes, canonically encoded');
  return toHex(bytes);
}

/**
 * wsh fingerprint (hex SHA-256 of the raw key) to a pod id.
 * @param {string} fingerprint 64 hex characters (either case)
 * @returns {string}
 */
export function fingerprintToPodId(fingerprint) {
  if (typeof fingerprint !== 'string' || !HEX_FP_RE.test(fingerprint)) throw new TypeError('fingerprintToPodId: expected a 64 character hex fingerprint');
  return encodeBase64url(fromHex(fingerprint.toLowerCase()));
}

function checkRaw(raw, who) {
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new TypeError(`${who}: expected a 32 byte raw Ed25519 public key`);
}

function sshBlob(raw) {
  const type = new TextEncoder().encode(SSH_TYPE);
  const blob = new Uint8Array(4 + type.length + 4 + raw.length);
  const view = new DataView(blob.buffer);
  view.setUint32(0, type.length);
  blob.set(type, 4);
  view.setUint32(4 + type.length, raw.length);
  blob.set(raw, 4 + type.length + 4);
  return blob;
}

function base64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const COMMENT_RE = /^[\x20-\x7e]{0,256}$/;
function checkComment(comment, who) {
  if (comment === undefined || comment === '') return '';
  if (typeof comment !== 'string' || !COMMENT_RE.test(comment) || comment !== comment.trim()) {
    throw new TypeError(`${who}: a comment is up to 256 printable ASCII characters, with no line break and no leading or trailing space`);
  }
  return comment;
}

/**
 * The OpenSSH public key line of a raw Ed25519 public key: `ssh-ed25519 AAAA...`, then the comment if there is one.
 * @param {Uint8Array} rawPublicKey 32 bytes
 * @param {{ comment?: string }} [opts]
 * @returns {string}
 */
export function openSSHPublicKeyFromRaw(rawPublicKey, { comment } = {}) {
  checkRaw(rawPublicKey, 'openSSHPublicKeyFromRaw');
  const note = checkComment(comment, 'openSSHPublicKeyFromRaw');
  return `${SSH_TYPE} ${base64(sshBlob(rawPublicKey))}${note ? ` ${note}` : ''}`;
}

/**
 * The raw Ed25519 public key of an OpenSSH public key line (`ssh-ed25519 AAAA... [comment]`).
 * Refuses anything else: another key type, a line with options in front, base64 that is not canonical, a blob that is
 * not exactly one 32 byte key, a line break or other control character.
 * @param {string} line
 * @returns {Uint8Array} 32 bytes
 */
export function rawPublicKeyFromOpenSSH(line) {
  if (typeof line !== 'string' || line.length > MAX_LINE_LENGTH) throw new TypeError('rawPublicKeyFromOpenSSH: expected a public key line');
  if (/[\x00-\x1f\x7f]/.test(line.replace(/^[ \t]+|[ \t]+$/g, ''))) throw new TypeError('rawPublicKeyFromOpenSSH: a public key line is one line without control characters');
  const match = /^[ \t]*ssh-ed25519[ \t]+([A-Za-z0-9+/]+)(?:[ \t]+.*)?[ \t]*$/.exec(line);
  if (!match || match[1].length !== SSH_BLOB_BASE64_LENGTH) throw new TypeError('rawPublicKeyFromOpenSSH: expected "ssh-ed25519 <key> [comment]" (options and other key types are refused)');
  let blob;
  try {
    const binary = atob(match[1]);
    blob = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch { throw new TypeError('rawPublicKeyFromOpenSSH: the key is not base64'); }
  if (base64(blob) !== match[1]) throw new TypeError('rawPublicKeyFromOpenSSH: the base64 is not canonical');
  const view = new DataView(blob.buffer);
  const typeLength = new TextEncoder().encode(SSH_TYPE).length;
  const ok = blob.length === 4 + typeLength + 4 + 32
    && view.getUint32(0) === typeLength
    && new TextDecoder().decode(blob.subarray(4, 4 + typeLength)) === SSH_TYPE
    && view.getUint32(4 + typeLength) === 32;
  if (!ok) throw new TypeError('rawPublicKeyFromOpenSSH: the key blob is not exactly one ssh-ed25519 public key');
  return blob.slice(4 + typeLength + 4);
}

/**
 * The pod id of an OpenSSH public key line.
 * @param {string} line
 * @returns {Promise<string>}
 */
export async function podIdFromOpenSSHPublicKey(line) {
  return podIdFromRawKey(rawPublicKeyFromOpenSSH(line));
}

const CAPABILITY_RE = /^[\x21\x23-\x2b\x2d-\x5b\x5d-\x7e]{1,256}$/; // printable, no space, no `"`, no `,`, no `\`
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

function expiryText(expires) {
  if (expires === undefined || expires === null) return null;
  if (typeof expires === 'string') {
    if (!RFC3339_RE.test(expires) || Number.isNaN(Date.parse(expires))) throw new TypeError('authorizedKeysLine: expires must be an RFC 3339 time to the second, such as 2030-01-01T00:00:00Z');
    return expires;
  }
  const ms = expires instanceof Date ? expires.getTime() : expires;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new TypeError('authorizedKeysLine: expires must be a Date, a number of milliseconds or an RFC 3339 string');
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * A wsh / OpenSSH `authorized_keys` line for a raw public key, with `capabilities="a,b"` and `expires="..."` options
 * (wsh's key capabilities: default-deny, and `expires` holds at login and for every request after it).
 *
 * `capabilities` is REQUIRED, even when empty (`[]` is a key that may do nothing): a key line with no capabilities
 * option is a key that may do everything the machine's other options allow, and this function will not write one by
 * accident. Each capability is printable ASCII with no space, `"`, `,` or `\` (it cannot end the option, start another
 * or break the line); the vocabulary is the host's, and a host fails closed on one it does not know.
 * Listing a browser-held key in a machine's `authorized_keys` is a decision with consequences: see docs/security.md,
 * "One key in both worlds".
 *
 * @param {object} opts
 * @param {Uint8Array} opts.rawPublicKey 32 bytes
 * @param {string[]} opts.capabilities
 * @param {Date|number|string} [opts.expires]
 * @param {string} [opts.comment]
 * @returns {string}
 */
export function authorizedKeysLine({ rawPublicKey, capabilities, expires, comment } = {}) {
  checkRaw(rawPublicKey, 'authorizedKeysLine');
  if (!Array.isArray(capabilities)) throw new TypeError('authorizedKeysLine: capabilities is required (an array, possibly empty): a key line with none would allow everything');
  if (capabilities.length > 64) throw new TypeError('authorizedKeysLine: at most 64 capabilities');
  for (const capability of capabilities) {
    if (typeof capability !== 'string' || !CAPABILITY_RE.test(capability)) throw new TypeError('authorizedKeysLine: a capability is 1 to 256 printable ASCII characters without space, quote, comma or backslash');
  }
  if (new Set(capabilities).size !== capabilities.length) throw new TypeError('authorizedKeysLine: a capability is listed once');
  const options = [`capabilities="${capabilities.join(',')}"`];
  const until = expiryText(expires);
  if (until !== null) options.push(`expires="${until}"`);
  return `${options.join(',')} ${openSSHPublicKeyFromRaw(rawPublicKey, { comment })}`;
}
