/**
 * Encode a Uint8Array as a base64url string (no padding).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encodeBase64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url string (no padding) to a Uint8Array.
 *
 * @param {string} str
 * @returns {Uint8Array}
 */
export function decodeBase64url(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @type {boolean|null} Cached Ed25519 probe result; null until it resolves. */
let _ed25519Supported = null;

/** @type {Promise<boolean>|null} In-flight probe, so it runs at most once. */
let _ed25519Probe = null;

/**
 * Probe for WebCrypto Ed25519 support by asking for a key. Resolves true or
 * false, never throws, and caches the answer.
 *
 * This library has no software fallback for Ed25519, so a false here means the
 * whole identity layer is unavailable in this environment. WebCrypto Ed25519
 * shipped in **Safari 17** and **Chromium 137** — the latter is recent enough
 * that Android devices with an un-updated System WebView will not have it.
 * Call this before PodIdentity.generate() if you need to degrade gracefully
 * rather than catch a NotSupportedError from four frames down.
 *
 * @returns {Promise<boolean>}
 */
export function probeEd25519Support() {
  if (_ed25519Probe) return _ed25519Probe;
  _ed25519Probe = (async () => {
    if (typeof crypto === 'undefined' || !crypto.subtle ||
        typeof crypto.subtle.generateKey !== 'function') {
      return false;
    }
    try {
      await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
      return true;
    } catch {
      return false;
    }
  })().then((ok) => {
    _ed25519Supported = ok;
    return ok;
  });
  return _ed25519Probe;
}

/**
 * Cached answer from probeEd25519Support(), or null when the probe has not
 * resolved yet. Treat null as "unknown"; await probeEd25519Support() for a
 * definite answer.
 *
 * @returns {boolean|null}
 */
export function supportsEd25519() {
  if (_ed25519Supported === null) probeEd25519Support();
  return _ed25519Supported;
}

/** Reset the cached Ed25519 probe. Tests only. */
export function _resetEd25519Probe() {
  _ed25519Supported = null;
  _ed25519Probe = null;
}

/**
 * Derive a pod ID from an Ed25519 public key.
 * Pod ID = base64url(SHA-256(raw public key bytes)).
 *
 * @param {CryptoKey} publicKey - Ed25519 public key
 * @returns {Promise<string>} Base64url-encoded pod ID
 */
export async function derivePodId(publicKey) {
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return encodeBase64url(new Uint8Array(hash));
}

/**
 * Represents a BrowserMesh pod identity (Ed25519 key pair).
 *
 * @class
 */
export class PodIdentity {
  /** @type {((data: BufferSource) => Uint8Array|Promise<Uint8Array>)|null} */
  #signer = null;

  /** @type {Uint8Array|null} */
  #rawPublicKey = null;

  /**
   * @param {object} opts
   * @param {CryptoKeyPair} opts.keyPair - Ed25519 key pair. For an identity
   *   backed by an external signer, `privateKey` is `null`.
   * @param {string} opts.podId - Base64url-encoded public key hash
   * @param {(data: BufferSource) => Uint8Array|Promise<Uint8Array>} [opts.signer]
   *   - Signing function for an identity whose private key this object does
   *   not hold. Prefer `PodIdentity.fromSigner()`, which validates it.
   */
  constructor({ keyPair, podId, signer }) {
    /** @type {CryptoKeyPair} */
    this.keyPair = keyPair;
    /** @type {string} */
    this.podId = podId;
    if (signer !== undefined && signer !== null) {
      if (typeof signer !== 'function') throw new TypeError('PodIdentity: signer must be a function');
      this.#signer = signer;
    }
  }

  /**
   * True when the private key is a `CryptoKey` this page could export
   * (`extractable: true`). False for a non-extractable key and for a signer
   * identity, whose key this object never holds.
   *
   * @returns {boolean}
   */
  get extractable() {
    return !this.#signer && !!this.keyPair?.privateKey && this.keyPair.privateKey.extractable === true;
  }

  /**
   * True when signing goes to an external signer (vault, token, extension).
   *
   * @returns {boolean}
   */
  get isExternalSigner() {
    return this.#signer !== null;
  }

  /**
   * The raw 32-byte Ed25519 public key. Exports the PUBLIC key only (always
   * allowed by WebCrypto); the result is cached.
   *
   * @returns {Promise<Uint8Array>}
   */
  async rawPublicKey() {
    if (!this.#rawPublicKey) {
      this.#rawPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', this.keyPair.publicKey));
    }
    return new Uint8Array(this.#rawPublicKey);
  }

  /**
   * Export the private key. Only for an identity created as exportable: a
   * non-extractable key or an external signer rejects. Nothing else in this
   * package calls `exportKey` on a private key.
   *
   * @param {'jwk'|'pkcs8'} [format='jwk']
   * @returns {Promise<object|Uint8Array>}
   */
  async exportPrivateKey(format = 'jwk') {
    if (format !== 'jwk' && format !== 'pkcs8') throw new TypeError("PodIdentity.exportPrivateKey: format must be 'jwk' or 'pkcs8'");
    if (!this.extractable) {
      throw new Error('PodIdentity.exportPrivateKey: this identity is not exportable (non-extractable key or external signer)');
    }
    const out = await crypto.subtle.exportKey(format, this.keyPair.privateKey);
    return format === 'pkcs8' ? new Uint8Array(out) : out;
  }

  /**
   * Wrap an existing Ed25519 `CryptoKeyPair`, including one whose private key
   * is non-extractable (for example loaded from IndexedDB or generated with
   * `extractable: false`).
   *
   * @param {CryptoKeyPair} keyPair
   * @returns {Promise<PodIdentity>}
   */
  static async fromCryptoKeyPair(keyPair) {
    if (!keyPair || !keyPair.publicKey || !keyPair.privateKey) {
      throw new TypeError('PodIdentity.fromCryptoKeyPair: expected { publicKey, privateKey } CryptoKeys');
    }
    if (keyPair.publicKey.algorithm?.name !== 'Ed25519' || keyPair.privateKey.algorithm?.name !== 'Ed25519') {
      throw new TypeError('PodIdentity.fromCryptoKeyPair: keys must be Ed25519');
    }
    const podId = await derivePodId(keyPair.publicKey);
    return new PodIdentity({ keyPair, podId });
  }

  /**
   * Import a private key as JWK (the format `MeshIdentityManager.export()`
   * produces). The public half comes from the JWK's `x`; the private key is
   * non-extractable unless `extractable: true` is passed.
   *
   * @param {object} jwk - Ed25519 private JWK (`kty: 'OKP'`, `crv: 'Ed25519'`, `x`, `d`)
   * @param {{ extractable?: boolean }} [opts]
   * @returns {Promise<PodIdentity>}
   */
  static async fromJwk(jwk, { extractable = false } = {}) {
    if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string') {
      throw new TypeError('PodIdentity.fromJwk: expected an Ed25519 private JWK with x and d');
    }
    const privateKey = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'], ext: true }, { name: 'Ed25519' }, !!extractable, ['sign']);
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: jwk.x, key_ops: ['verify'], ext: true },
      { name: 'Ed25519' },
      true,
      ['verify']
    );
    const identity = new PodIdentity({ keyPair: { publicKey, privateKey }, podId: await derivePodId(publicKey) });
    await identity.#checkPair();
    return identity;
  }

  /**
   * Import a private key as PKCS#8. PKCS#8 does not carry the public key and
   * WebCrypto cannot derive it from a non-extractable key, so pass it as
   * `publicKey` (raw 32 bytes or a public `CryptoKey`). If you ask for
   * `extractable: true` the public key may be omitted and is derived by
   * exporting the key you handed over. The result is checked with one
   * sign/verify round trip so a mismatched pair is rejected.
   *
   * @param {BufferSource} pkcs8
   * @param {{ extractable?: boolean, publicKey?: Uint8Array|CryptoKey }} [opts]
   * @returns {Promise<PodIdentity>}
   */
  static async fromPkcs8(pkcs8, { extractable = false, publicKey } = {}) {
    if (!publicKey && !extractable) {
      throw new TypeError(
        'PodIdentity.fromPkcs8: pass the public key (raw bytes or CryptoKey) for a non-extractable import, ' +
        'or ask for extractable: true so it can be derived'
      );
    }
    const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, !!extractable, ['sign']);
    let pub;
    if (publicKey) {
      pub = await importPublicKey(publicKey);
    } else {
      const jwk = await crypto.subtle.exportKey('jwk', privateKey);
      pub = await crypto.subtle.importKey(
        'jwk',
        { kty: 'OKP', crv: 'Ed25519', x: jwk.x, key_ops: ['verify'], ext: true },
        { name: 'Ed25519' },
        true,
        ['verify']
      );
    }
    const identity = new PodIdentity({ keyPair: { publicKey: pub, privateKey }, podId: await derivePodId(pub) });
    await identity.#checkPair();
    return identity;
  }

  /**
   * An identity whose private key lives elsewhere: a vault, a hardware token,
   * an extension, a WebAuthn-like holder. Everything that signs goes through
   * `signer.sign`.
   *
   * The signer shape is the one `@johnhenry/wsh` takes for "signing with a
   * page-held signer" -- `{ publicKey, sign(data) }` with `publicKey` the raw
   * 32-byte Ed25519 key or a public `CryptoKey`, and `sign` returning the
   * 64-byte signature, sync or async -- so one signer object can serve both
   * libraries.
   *
   * @param {{ publicKey: Uint8Array|CryptoKey, sign: (data: Uint8Array) => Uint8Array|Promise<Uint8Array> }} signer
   * @param {{ check?: boolean }} [opts] - `check: true` makes one test signature at construction (one use of the signer) to confirm it matches `publicKey`
   * @returns {Promise<PodIdentity>}
   */
  static async fromSigner(signer, { check = false } = {}) {
    if (!signer || typeof signer.sign !== 'function' || !signer.publicKey) {
      throw new TypeError('PodIdentity.fromSigner: expected { publicKey, sign(data) }');
    }
    const publicKey = await importPublicKey(signer.publicKey);
    const sign = async (data) => {
      const sig = await signer.sign(toBytes(data));
      const bytes = sig instanceof ArrayBuffer ? new Uint8Array(sig) : sig;
      if (!(bytes instanceof Uint8Array) || bytes.length !== ED25519_SIGNATURE_BYTES) {
        throw new TypeError('PodIdentity signer.sign must return a 64-byte Ed25519 signature');
      }
      return new Uint8Array(bytes);
    };
    const identity = new PodIdentity({
      keyPair: { publicKey, privateKey: null },
      podId: await derivePodId(publicKey),
      signer: sign,
    });
    if (check) await identity.#checkPair();
    return identity;
  }

  async #checkPair() {
    const probe = crypto.getRandomValues(new Uint8Array(32));
    const sig = await this.sign(probe);
    if (!(await crypto.subtle.verify('Ed25519', this.keyPair.publicKey, sig, probe))) {
      throw new Error('PodIdentity: the private key does not match the public key');
    }
  }

  /**
   * Generate a new PodIdentity with a fresh Ed25519 key pair.
   *
   * Requires WebCrypto Ed25519 (Safari 17+, Chromium 137+). There is no
   * software fallback: where the algorithm is missing this throws with a
   * message naming the requirement rather than a bare NotSupportedError.
   * Use probeEd25519Support() to check first.
   *
   * The private key is extractable by default (existing behaviour); pass
   * `{ extractable: false }` for a key this page can use but never read.
   *
   * @param {{ extractable?: boolean }} [opts]
   * @returns {Promise<PodIdentity>}
   */
  static async generate({ extractable = true } = {}) {
    let keyPair;
    try {
      keyPair = await crypto.subtle.generateKey(
        { name: 'Ed25519' },
        !!extractable,
        ['sign', 'verify']
      );
    } catch (err) {
      throw new Error(
        'WebCrypto Ed25519 is unavailable in this environment, and this library ' +
        'has no software fallback. Ed25519 requires Safari 17+ or Chromium 137+ ' +
        '(including the Android System WebView). Original error: ' +
        (err && err.message ? err.message : String(err)),
        { cause: err }
      );
    }
    const podId = await derivePodId(keyPair.publicKey);
    return new PodIdentity({ keyPair, podId });
  }

  /**
   * Sign data with this identity's private key.
   *
   * @param {BufferSource} data - Data to sign
   * @returns {Promise<Uint8Array>} Ed25519 signature
   */
  async sign(data) {
    // The one signing seam: an external signer or the CryptoKey, nothing else.
    if (this.#signer) return this.#signer(data);
    return new Uint8Array(
      await crypto.subtle.sign('Ed25519', this.keyPair.privateKey, data)
    );
  }

  /**
   * Verify a signature against a public key.
   *
   * Argument order is `(publicKey, signature, data)`, the same as WebCrypto's
   * `crypto.subtle.verify('Ed25519', publicKey, signature, data)`.
   *
   * BREAKING (primitives 0.2.0): releases before this took
   * `(publicKey, data, signature)`. A guard throws a TypeError when the old
   * order is detected (Ed25519 signatures are exactly 64 bytes) rather than
   * silently returning false.
   *
   * @param {CryptoKey} publicKey - Ed25519 public key
   * @param {BufferSource} signature - Signature to verify (64 bytes)
   * @param {BufferSource} data - Original data
   * @returns {Promise<boolean>}
   */
  static async verify(publicKey, signature, data) {
    if (
      byteLengthOf(signature) !== ED25519_SIGNATURE_BYTES &&
      byteLengthOf(data) === ED25519_SIGNATURE_BYTES
    ) {
      throw new TypeError(
        'PodIdentity.verify: argument order changed to (publicKey, signature, data) ' +
        'in this version (previously (publicKey, data, signature)); ' +
        'the signature argument is not 64 bytes but the data argument is'
      );
    }
    return crypto.subtle.verify('Ed25519', publicKey, signature, data);
  }
}

const ED25519_SIGNATURE_BYTES = 64;

/**
 * @param {BufferSource} v
 * @returns {Uint8Array}
 */
function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(v);
}

/**
 * Import an Ed25519 public key from raw bytes or accept a public CryptoKey.
 * Only ever touches public keys.
 *
 * @param {Uint8Array|CryptoKey} key
 * @returns {Promise<CryptoKey>}
 */
async function importPublicKey(key) {
  if (key instanceof Uint8Array) {
    if (key.length !== 32) throw new TypeError('Ed25519 public key must be 32 raw bytes');
    return crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, true, ['verify']);
  }
  if (key && typeof key === 'object' && key.type === 'public' && key.algorithm?.name === 'Ed25519') return key;
  throw new TypeError('public key must be 32 raw bytes or a public Ed25519 CryptoKey');
}

/**
 * @param {BufferSource} v
 * @returns {number}
 */
function byteLengthOf(v) {
  return v && typeof v.byteLength === 'number' ? v.byteLength : -1;
}
