/**
 * wsh-links.mjs -- mesh peer links carried on wsh sessions.
 *
 * A link between pod A and pod B is ONE wsh session that is key-authenticated
 * in both directions and sealed end to end, carrying ONE named endpoint
 * (`mesh`) whose duplex byte stream holds the mesh's frames (`wsh-frames.mjs`).
 * Between two browsers neither side can listen, so a pod that wants to be
 * reached is a wsh host dialled in through a pipe relay (`@johnhenry/wsh/
 * pipe-relay`) that vouches for nothing, and a pod that wants to reach it is a
 * wsh client. Design and threat model: `docs/design/wsh-peer-link.md`.
 *
 * What this file enforces, and does not leave to the caller:
 *  - the pod id a peer claims is the hash of the key wsh authenticated
 *    (login username = pod id; the host refuses a mismatch);
 *  - the dialler pins the host key to the pod id it meant to reach;
 *  - the session is sealed (there is no setting that makes it plain) and the
 *    dialler checks `client.sessionSealed` after login;
 *  - a peer is allowed only if the `authorize` callback says so (default:
 *    nobody), and the key is given nothing but the `endpoint:mesh` capability
 *    (or, for a `{ restricted: true }` verdict, `endpoint:mesh-admission`: see
 *    `docs/design/link-admission.md`);
 *  - frames are length-prefixed with a maximum enforced on the header.
 *
 * `@johnhenry/wsh` is an optional peer dependency, imported lazily on first
 * `listen()` / `connect()`.
 */

import { encodeBase64url, podIdToFingerprint, fingerprintToPodId, podIdFromRawKey } from '@johnhenry/browsermesh-primitives';
import { encodeFrame, FrameDecoder, WshFrameError, DEFAULT_MAX_FRAME_BYTES } from './wsh-frames.mjs';
import { loadWatchPairing, waitingHalf } from './wsh-pairing.mjs';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every failure of a wsh link is one of these, with a stable `code`:
 * `WSH_HOSTKEY_MISMATCH`, `WSH_REFUSED` (`reason` says why), `WSH_IDENTITY_MISMATCH`,
 * `WSH_NOT_SEALED`, `WSH_UNREACHABLE`, `WSH_SEAL_FAILED`, `WSH_FRAME_TOO_LARGE`,
 * `WSH_BAD_FRAME`, `WSH_BACKPRESSURE`, `WSH_CLOSED`, `WSH_UNAVAILABLE`.
 */
export class WshLinkError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ reason?: string, cause?: unknown, podId?: string }} [extra]
   */
  constructor(code, message, { reason, cause, podId } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'WshLinkError';
    this.code = code;
    if (reason !== undefined) this.reason = reason;
    if (podId !== undefined) this.podId = podId;
  }
}

/** Failures that do not get better by trying again. */
const FATAL = new Set(['WSH_HOSTKEY_MISMATCH', 'WSH_REFUSED', 'WSH_NOT_SEALED', 'WSH_UNAVAILABLE']);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

// The conversion between a pod id and wsh's hex fingerprint (and the pod id of a
// raw key) lives in ONE place, `@johnhenry/browsermesh-primitives`; the names stay
// exported from here for the callers that already import them from this package.
export { podIdToFingerprint, fingerprintToPodId, podIdFromRawKey };

const RENDEZVOUS_LABEL = 'browsermesh-wsh-link/1:';

/**
 * The pipe relay rendezvous id a pod listens at: base64url(SHA-256(label ||
 * pod id)), 43 characters. Derived from a public value; nothing relies on it
 * being secret.
 * @param {string} podId
 * @returns {Promise<string>}
 */
export async function rendezvousId(podId) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RENDEZVOUS_LABEL + podId));
  return encodeBase64url(new Uint8Array(hash));
}

/**
 * Simultaneous dial tie-break. Of two links between the same pair, the one
 * whose INITIATOR has the smaller pod id survives. Both sides evaluate the same
 * two initiators and so agree without a message.
 * @param {string} initiatorPodId
 * @param {string} otherInitiatorPodId
 * @returns {boolean} true when `initiatorPodId` wins
 */
export function initiatorWins(initiatorPodId, otherInitiatorPodId) {
  return initiatorPodId < otherInitiatorPodId;
}

/**
 * Turn what a caller gives (a `PodIdentity`, or `{ podId, signer }` for a key
 * held elsewhere) into what wsh takes, and check that the pod id is the hash of
 * the key.
 * @param {{ podId?: string, keyPair?: CryptoKeyPair, signer?: { publicKey: Uint8Array | CryptoKey, sign: (data: Uint8Array) => Uint8Array | Promise<Uint8Array> } }} identity
 * @returns {Promise<{ podId: string, publicKeyRaw: Uint8Array, keyPair?: CryptoKeyPair, signer?: object }>}
 */
export async function resolveCredential(identity) {
  if (!identity || typeof identity !== 'object') throw new TypeError('identity is required (a PodIdentity, or { podId, signer })');
  const { keyPair, signer } = identity;
  if (!keyPair && !signer) throw new TypeError('identity needs a keyPair or a signer');
  if (keyPair && signer) throw new TypeError('identity takes a keyPair or a signer, not both');
  let key = keyPair ? keyPair.publicKey : signer.publicKey;
  if (key && typeof key === 'object' && 'type' in key && key.type === 'public') key = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new TypeError('identity public key must be a 32 byte Ed25519 key');
  const podId = await podIdFromRawKey(key);
  if (identity.podId !== undefined && identity.podId !== podId) throw new Error('identity pod id is not the hash of its public key');
  return keyPair ? { podId, publicKeyRaw: key, keyPair } : { podId, publicKeyRaw: key, signer: { publicKey: key, sign: signer.sign.bind(signer) } };
}

// ---------------------------------------------------------------------------
// Lazy wsh
// ---------------------------------------------------------------------------

let clientModule = null;
let hostModule = null;

// Literal specifiers on purpose: a bundler can only split (and a browser can only
// resolve) an import() whose specifier it can read.
async function loadWsh(load) {
  try {
    return await load();
  } catch (cause) {
    throw new WshLinkError('WSH_UNAVAILABLE', `the wsh transport needs @johnhenry/wsh 0.45 or later: install it (npm install @johnhenry/wsh).${cause?.message ?? ''}`.trim(), { cause });
  }
}
const loadClient = () => (clientModule ??= loadWsh(() => import('@johnhenry/wsh')));
const loadHost = () => (hostModule ??= loadWsh(() => import('@johnhenry/wsh/memory')));

function pipeUrl(relay, id, role, notifyPaired = false) {
  const u = new URL(relay);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/r/${id}`;
  // `paired=1` asks a relay to tell a waiting host half when its peer arrives (wsh 0.54.1); a relay that predates it ignores it.
  u.search = role === 'host' ? (notifyPaired ? '?role=host&paired=1' : '?role=host') : '';
  return u.toString();
}

const ENDPOINT = 'mesh';
/**
 * The endpoint a peer with a RESTRICTED verdict may open instead of `mesh` (see `authorize`'s `{ restricted: true }`). wsh's own
 * capability check keeps the two apart: a key granted `endpoint:mesh-admission` cannot open `mesh`, whatever races.
 */
const ADMISSION_ENDPOINT = 'mesh-admission';

/**
 * wsh logins take a user name that starts with a letter or an underscore, and a
 * base64url pod id may start with a digit or a dash, so the user name a pod logs
 * in with is the pod id behind this prefix.
 */
export const LINK_USERNAME_PREFIX = 'pod_';

/** The login user name that claims `podId`. */
export const usernameForPodId = (podId) => `${LINK_USERNAME_PREFIX}${podId}`;

/** Map what wsh throws on a dial to a `WshLinkError`. */
function mapDialError(err, podId) {
  if (err instanceof WshLinkError) return err;
  const msg = String(err?.message ?? err);
  if (err?.name === 'HostKeyError' || /^HOST_KEY_/.test(err?.code ?? '')) {
    return new WshLinkError('WSH_HOSTKEY_MISMATCH', `the host reached for ${podId} did not prove that pod's key (${msg})`, { cause: err, podId, reason: 'host-key' });
  }
  if (/^Authentication failed/i.test(msg)) {
    return new WshLinkError('WSH_REFUSED', `${podId} refused this pod: ${msg}`, { cause: err, podId, reason: 'unauthorized' });
  }
  if (/sealed session/i.test(msg)) {
    return new WshLinkError('WSH_NOT_SEALED', `no sealed session with ${podId}: ${msg}`, { cause: err, podId, reason: 'not-sealed' });
  }
  return new WshLinkError('WSH_UNREACHABLE', `could not reach ${podId}: ${msg}`, { cause: err, podId });
}

// ---------------------------------------------------------------------------
// WshPeerLinks
// ---------------------------------------------------------------------------

const DEFAULT_RECONNECT = { baseMs: 250, maxMs: 10_000, maxAttempts: Infinity };
const EVENTS = ['peer-up', 'peer-down', 'message', 'refused', 'error', 'dropped'];

/**
 * The hub for one pod's wsh links: it listens (as a wsh host at the pod's own
 * rendezvous id on each relay), dials (as a wsh client at the peer's), applies
 * the tie-break when both happen at once, and hands the mesh whole frames
 * tagged with the authenticated sender.
 *
 * Events: `peer-up` `{ podId, initiator: 'local'|'remote' }`, `peer-down`
 * `{ podId, reason, error? }`, `message` `{ from, data }` (a handler may return
 * a promise: the next frame is not read until it settles), `refused`
 * `{ reason, who, detail }`, `error` `{ error }`, `dropped` `{ from, reason }`.
 */
export class WshPeerLinks {
  /** Capability flag: `authorize(peer, { restricted: true })` is called, and a `{ restricted: true }` verdict is understood. Absent in older releases. */
  static supportsRestrictedAdmission = true;

  #identity;
  #cred = null;
  #credReady;
  #relays;
  #WebSocketCtor;
  #socketFactory;
  #authorize;
  #beforeDial;
  #maxFrame;
  #maxQueued;
  #slotsWanted;
  #connectTimeoutMs;
  #reconnect;
  #keepAlive;
  #supersedeGraceMs;
  #userOnRefused;
  #onLog;
  #bindTimeoutMs;
  #admission;
  /** @type {Set<object>} restricted connections (not peers: they are in no `#peers` entry until promoted) */
  #restricted = new Set();

  #listeners = new Map();
  /** @type {Map<string, { active: object|null, all: Set<object> }>} */
  #peers = new Map();
  /** @type {Map<string, Promise<void>>} */
  #dials = new Map();
  /** @type {Map<string, { attempts: number, timer: any }>} */
  #wanted = new Map();
  #host = null;
  /** wsh's `watchPairing`, or null when the installed wsh predates `accept(socket, { waitForPeer })` (0.54.1). */
  #watchPairing = null;
  #listening = false;
  #closed = false;
  /** @type {Map<string, Set<object>>} relay -> waiting host halves */
  #slots = new Map();
  /** @type {Map<string, any>} relay -> pending retry timer */
  #slotRetry = new Map();
  /** @type {Map<string, number>} relay -> consecutive failed registrations */
  #slotAttempts = new Map();
  #ownRid = null;
  #pendingReasons = new Map();
  #stats = { linksEstablished: 0, superseded: 0, messagesIn: 0, messagesOut: 0, bytesIn: 0, bytesOut: 0, refused: 0, dropped: 0 };
  #nextConnId = 1;

  /**
   * @param {object} opts
   * @param {object} opts.identity - a `PodIdentity`, or `{ podId, signer }`
   * @param {string|string[]} [opts.relays] - pipe relay base URL(s), `wss://relay.example/`
   * @param {Function} [opts.WebSocket] - WebSocket constructor (default `globalThis.WebSocket`)
   * @param {(url: string, info: { role: 'host'|'operator', id: string, relay: string }) => object} [opts.socketFactory]
   *   Opens the WebSocket-like socket for a pipe; the seam for a test relay, a direct URL or a pipe carried some other way.
   * @param {(peer: { podId: string, fingerprint: string, publicKey: Uint8Array }) => boolean | { expires?: string|Date|number } | Promise<boolean | { expires?: string|Date|number }>} [opts.authorize]
   *   Who may link to this pod. Asked after the key's signature verified and before any mesh frame. Default: nobody.
   *   It may also return `{ restricted: true }` (with an optional `expires`): the peer is logged in but may open only the admission
   *   endpoint, its link is not a peer (no `peer-up`, no `message`), and its frames go to `opts.admission` until that promotes it.
   *   Without `opts.admission` a restricted verdict is a refusal.
   * @param {{ admit: (info: { peerKey: string, transport: 'wsh', proven: true, channel: object }) => Promise<{ state: string, reason?: string }> }} [opts.admission]
   *   The admission seam (`createLinkAdmission()` from browsermesh-apps, or any object with `admit`). It owns the cap, the
   *   deadline and the frame limit of restricted links. `channel` is `{ send(frame), onFrame(cb), onClose(cb), close(reason), adopt() }`.
   * @param {(info: { podId: string }) => void | Promise<void>} [opts.beforeDial] - Called before each outbound dial; throw to veto.
   * @param {number} [opts.maxFrameBytes=1048576]
   * @param {number} [opts.maxQueuedBytes=4194304] - Bytes a link may queue behind the endpoint's credit window.
   * @param {number} [opts.listenSlots=2] - Host halves kept waiting per relay.
   * @param {number} [opts.connectTimeoutMs=15000]
   * @param {{ baseMs?: number, maxMs?: number, maxAttempts?: number }} [opts.reconnect]
   * @param {{ pingIntervalMs?: number, pongTimeoutMs?: number }} [opts.keepAlive] - wsh client keepalive for links this pod dials.
   * @param {number} [opts.supersedeGraceMs=2000] - How long a superseded link may drain.
   * @param {(refusal: { reason: string, who: object, detail: string }) => void} [opts.onRefused]
   * @param {(line: string) => void} [opts.onLog]
   */
  constructor(opts = {}) {
    if (!opts.identity) throw new TypeError('WshPeerLinks requires { identity }');
    this.#identity = opts.identity;
    this.#credReady = resolveCredential(opts.identity).then((c) => { this.#cred = c; return c; });
    this.#credReady.catch(() => {});
    const relays = opts.relays === undefined ? [] : Array.isArray(opts.relays) ? opts.relays : [opts.relays];
    for (const r of relays) {
      let u;
      try { u = new URL(r); } catch { throw new TypeError(`relay is not a URL: ${r}`); }
      if (!/^(wss?|https?):$/.test(u.protocol)) throw new TypeError(`relay must be a ws(s) or http(s) URL: ${r}`);
    }
    this.#relays = relays;
    this.#WebSocketCtor = opts.WebSocket ?? globalThis.WebSocket ?? null;
    this.#socketFactory = opts.socketFactory ?? null;
    this.#authorize = typeof opts.authorize === 'function' ? opts.authorize : () => false;
    this.#beforeDial = opts.beforeDial ?? null;
    this.#maxFrame = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    new FrameDecoder({ maxFrameBytes: this.#maxFrame }); // validates
    this.#maxQueued = opts.maxQueuedBytes ?? 4 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxQueued) || this.#maxQueued < 1) throw new TypeError('maxQueuedBytes must be a positive integer');
    this.#slotsWanted = opts.listenSlots ?? 2;
    if (!Number.isSafeInteger(this.#slotsWanted) || this.#slotsWanted < 1) throw new TypeError('listenSlots must be a positive integer');
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
    this.#reconnect = { ...DEFAULT_RECONNECT, ...opts.reconnect };
    this.#keepAlive = opts.keepAlive ?? {};
    this.#supersedeGraceMs = opts.supersedeGraceMs ?? 2000;
    this.#userOnRefused = typeof opts.onRefused === 'function' ? opts.onRefused : null;
    this.#onLog = opts.onLog ?? (() => {});
    this.#bindTimeoutMs = opts.bindTimeoutMs;
    if (opts.admission !== undefined && typeof opts.admission?.admit !== 'function') throw new TypeError('admission must have an admit() function');
    this.#admission = opts.admission ?? null;
  }

  // -- Public ---------------------------------------------------------------

  /** This pod's id (the hash of the key it authenticates with). */
  get podId() { return this.#cred?.podId ?? this.#identity.podId ?? null; }

  /** Resolves once the identity is checked; `podId` is reliable after it. */
  async ready() { await this.#credReady; return this.#cred.podId; }

  /** Pod ids with a live link. */
  peers() {
    return [...this.#peers].filter(([, e]) => e.active).map(([id]) => id);
  }

  isConnected(podId) { return !!this.#peers.get(podId)?.active; }

  /** Live links (including a superseded one still draining) to a peer. */
  linkCount(podId) {
    const e = this.#peers.get(podId);
    return e ? [...e.all].filter((c) => !c.ended).length : 0;
  }

  linkInfo(podId) {
    const c = this.#peers.get(podId)?.active;
    return c ? { podId, initiatorPodId: c.initiatorPodId, role: c.role, sealed: true, fingerprint: podIdToFingerprint(podId) } : null;
  }

  getStats() { return { ...this.#stats }; }

  on(event, cb) {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`);
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(cb);
    return () => this.off(event, cb);
  }

  off(event, cb) { this.#listeners.get(event)?.delete(cb); }

  /**
   * A transport object for one peer, shaped like the other mesh transports
   * (`send`, `onMessage`, `onClose`, `onError`, `connect`, `close`). It dials on
   * `connect()`.
   * @param {string} podId
   */
  link(podId) { return new WshLink(this, podId); }

  /**
   * Become reachable: keep `listenSlots` host halves waiting at this pod's
   * rendezvous id on every relay. Resolves once they are registered.
   */
  async listen() {
    if (this.#closed) throw new WshLinkError('WSH_CLOSED', 'the links are closed');
    if (this.#listening) return;
    this.#listening = true;
    const cred = await this.#credReady;
    this.#ownRid = await rendezvousId(cred.podId);
    const { createMemoryHost } = await loadHost();
    this.#watchPairing = await loadWatchPairing();
    if (this.#closed) return;
    this.#host = createMemoryHost({
      hostKey: cred.keyPair ?? cred.signer,
      dataStreams: false,
      sealSession: 'require',
      requireChannelBinding: true,
      // wsh counts its login deadline (60 s by default) from the moment the host accepts a socket, and a host half is accepted when it
      // reaches the relay, long before an operator pairs with it. From wsh 0.54.1 each half is accepted with `waitForPeer` (below), so
      // the deadline runs from the peer's arrival. With an older wsh there is no such option: 0.54.0 would close every idle half each
      // minute, so there the hosts carry no deadline at all (0.53 and earlier have none and ignore this).
      ...(this.#watchPairing ? {} : { loginTimeoutMs: 0 }),
      auth: (who) => this.#authorizePeer(who),
      endpoints: {
        [ENDPOINT]: (duplex, who) => this.#serve(duplex, who),
        ...(this.#admission ? { [ADMISSION_ENDPOINT]: (duplex, who) => this.#serveRestricted(duplex, who) } : {}),
      },
      onRefused: (r) => this.#onWshRefused(r),
      onLog: (line) => this.#onLog(line),
      ...(this.#bindTimeoutMs ? { bindTimeoutMs: this.#bindTimeoutMs } : {}),
    });
    await Promise.all(this.#relays.map((relay) => this.#fillSlots(relay)));
  }

  /**
   * Link to a peer: dial its rendezvous id on the configured relays, pin its
   * key to `podId`, log in with this pod's key, seal, open the mesh endpoint.
   * Resolves when a link to the peer is up (this one, or the one the tie-break
   * kept). With `keep` (default) the peer is redialled after an unplanned loss.
   * @param {string} podId
   * @param {{ keep?: boolean }} [opts]
   */
  async connect(podId, { keep = true } = {}) {
    if (this.#closed) throw new WshLinkError('WSH_CLOSED', 'the links are closed', { podId });
    const cred = await this.#credReady;
    podIdToFingerprint(podId);
    if (podId === cred.podId) throw new WshLinkError('WSH_REFUSED', 'a pod cannot link to itself', { podId });
    if (keep) this.#want(podId);
    if (this.isConnected(podId)) return this.linkInfo(podId);
    try {
      await this.#dial(podId);
    } catch (err) {
      if (FATAL.has(err.code)) this.#unwant(podId);
      else if (keep) this.#scheduleRedial(podId);
      throw err;
    }
    return this.linkInfo(podId) ?? { podId };
  }

  /**
   * Send one frame to a peer. The promise resolves when the endpoint's stream
   * accepted it (after credit), and rejects with `WSH_BACKPRESSURE` when the
   * queue is full, `WSH_FRAME_TOO_LARGE`, or `WSH_CLOSED`.
   * @param {string} podId
   * @param {*} data
   * @returns {Promise<void>}
   */
  send(podId, data) {
    const conn = this.#peers.get(podId)?.active;
    if (!conn) return Promise.reject(new WshLinkError('WSH_CLOSED', `no link to ${podId}`, { podId }));
    let frame;
    try {
      frame = encodeFrame(data, { maxFrameBytes: this.#maxFrame });
    } catch (err) {
      return Promise.reject(err instanceof WshFrameError ? new WshLinkError(err.code, err.message, { podId, cause: err }) : err);
    }
    return this.#enqueue(conn, frame);
  }

  /** Stop reading from a peer (its sender will stall once credit runs out). */
  pause(podId) {
    for (const c of this.#peers.get(podId)?.all ?? []) {
      if (!c.pause) { c.pause = {}; c.pause.promise = new Promise((r) => { c.pause.resolve = r; }); }
    }
  }

  resume(podId) {
    for (const c of this.#peers.get(podId)?.all ?? []) {
      if (c.pause) { c.pause.resolve(); c.pause = null; }
    }
  }

  /** Close the link to a peer and stop redialling it. */
  disconnect(podId) {
    this.#unwant(podId);
    const e = this.#peers.get(podId);
    if (!e) return;
    for (const c of [...e.all]) this.#end(c, 'local-close');
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const w of this.#wanted.values()) clearTimeout(w.timer);
    this.#wanted.clear();
    for (const t of this.#slotRetry.values()) clearTimeout(t);
    this.#slotRetry.clear();
    this.#slotAttempts.clear();
    for (const e of [...this.#peers.values()]) for (const c of [...e.all]) this.#end(c, 'local-close');
    for (const c of [...this.#restricted]) this.#end(c, 'local-close');
    for (const set of this.#slots.values()) for (const s of set) { try { s.ws?.close(); } catch { /* already closed */ } }
    this.#slots.clear();
    await this.#host?.close();
    this.#listeners.clear();
  }

  // -- Events ---------------------------------------------------------------

  #emit(event, payload) {
    const results = [];
    for (const cb of [...(this.#listeners.get(event) ?? [])]) {
      try { results.push(cb(payload)); } catch (e) { this.#onLog(`listener for ${event} threw: ${e?.message ?? e}`); }
    }
    return results;
  }

  #fail(error, extra = {}) { this.#emit('error', { error, ...extra }); }

  // -- Authorization (the listening side) -------------------------------------

  async #authorizePeer(who) {
    let podId;
    try { podId = fingerprintToPodId(who.fingerprint); } catch { return false; }
    if (who.username !== usernameForPodId(podId)) {
      this.#pendingReasons.set(who.fingerprint, 'identity-mismatch');
      return false;
    }
    if (podId === this.#cred.podId) return false;
    let verdict;
    try {
      // The second argument is a capability flag: `restricted: true` says this transport understands the `{ restricted: true }` verdict.
      // An authorizer that answers it only when told so fails closed against a transport that predates it.
      verdict = await this.#authorize({ podId, fingerprint: who.fingerprint, publicKey: who.publicKey }, { restricted: true });
    } catch (e) {
      this.#onLog(`authorize threw: ${e?.message ?? e}`);
      return false;
    }
    if (!verdict) return false;
    const restricted = typeof verdict === 'object' && verdict.restricted === true;
    if (restricted && !this.#admission) {
      this.#pendingReasons.set(who.fingerprint, 'no-admission');
      return false;
    }
    const grant = { capabilities: `endpoint:${restricted ? ADMISSION_ENDPOINT : ENDPOINT}` };
    if (typeof verdict === 'object' && verdict.expires !== undefined) grant.expires = verdict.expires;
    return grant;
  }

  #onWshRefused({ reason, who, detail }) {
    const own = who?.fingerprint ? this.#pendingReasons.get(who.fingerprint) : undefined;
    if (own) this.#pendingReasons.delete(who.fingerprint);
    const final = own ?? reason;
    this.#stats.refused++;
    // A sealed session whose frame did not open names the link that died.
    if (reason === 'seal-failed' && who?.fingerprint) {
      try {
        const conn = this.#peers.get(fingerprintToPodId(who.fingerprint))?.active;
        if (conn) conn.endReason = 'seal-failed';
      } catch { /* not a pod fingerprint */ }
    }
    const refusal = { reason: final, who: who ?? {}, detail };
    this.#emit('refused', refusal);
    if (this.#userOnRefused) {
      try { this.#userOnRefused(refusal); } catch (e) { this.#onLog(`onRefused threw: ${e?.message ?? e}`); }
    }
  }

  // -- Listening: waiting host halves -------------------------------------------

  #openSocket(role, id, relay) {
    const url = pipeUrl(relay, id, role, role === 'host' && this.#watchPairing !== null);
    if (this.#socketFactory) return this.#socketFactory(url, { role, id, relay });
    if (!this.#WebSocketCtor) throw new WshLinkError('WSH_UNAVAILABLE', 'no WebSocket constructor: pass { WebSocket } or run where one is global');
    return new this.#WebSocketCtor(url);
  }

  async #fillSlots(relay) {
    if (this.#closed || !this.#listening) return;
    let set = this.#slots.get(relay);
    if (!set) this.#slots.set(relay, (set = new Set()));
    const opening = [];
    while (set.size < this.#slotsWanted) opening.push(this.#openSlot(relay, set));
    await Promise.all(opening);
  }

  async #openSlot(relay, set) {
    const slot = { ws: null, paired: false };
    set.add(slot);
    let opened = false;
    try {
      const ws = this.#openSocket('host', this.#ownRid, relay);
      slot.ws = ws;
      try { ws.binaryType = 'arraybuffer'; } catch { /* read-only on some sockets */ }
      opened = await new Promise((resolve) => {
        if (ws.readyState === 1) return resolve(true);
        ws.addEventListener('open', () => resolve(true), { once: true });
        ws.addEventListener('error', () => resolve(false), { once: true });
        ws.addEventListener('close', () => resolve(false), { once: true });
      });
      if (opened) {
        ws.addEventListener('message', () => {
          if (slot.paired) return;
          slot.paired = true;
          set.delete(slot);
          this.#slotAttempts.delete(relay);
          void this.#fillSlots(relay);
        });
        ws.addEventListener('close', () => {
          if (slot.paired) return;
          set.delete(slot);
          this.#retrySlots(relay);
        });
        // The peer is not here yet: wsh starts the login clock when it arrives (the relay's paired signal, else its first byte).
        const half = waitingHalf(ws, this.#watchPairing);
        void this.#host.accept(half.socket, half.options).catch((e) => this.#onLog(`accept failed: ${e?.message ?? e}`));
      }
    } catch (e) {
      this.#onLog(`could not open a host half at ${relay}: ${e?.message ?? e}`);
    }
    if (!opened) {
      set.delete(slot);
      this.#retrySlots(relay);
    }
  }

  #retrySlots(relay) {
    if (this.#closed || this.#slotRetry.has(relay)) return;
    const prev = this.#slotAttempts.get(relay) ?? 0;
    const delay = Math.min(this.#reconnect.baseMs * 2 ** prev, this.#reconnect.maxMs);
    this.#slotAttempts.set(relay, prev + 1);
    const t = setTimeout(() => {
      this.#slotRetry.delete(relay);
      void this.#fillSlots(relay);
    }, delay);
    t.unref?.();
    this.#slotRetry.set(relay, t);
  }

  // -- Serving (the listening side's link) --------------------------------------

  async #serve(duplex, who) {
    let podId;
    try { podId = fingerprintToPodId(who.fingerprint); } catch { duplex.destroy?.('bad identity'); return; }
    if (who.username !== usernameForPodId(podId)) { duplex.destroy?.('identity mismatch'); return; }
    const conn = this.#newConn({ role: 'host', podId, initiatorPodId: podId, duplex });
    const done = new Promise((resolve) => { conn.onEnd = resolve; });
    this.#register(conn);
    await done;
  }

  /**
   * The listening side's link to a peer whose verdict was `{ restricted: true }`. It is not registered: no `peer-up`, no `message`
   * event, no entry in `peers()`. Its frames go to the admission seam, its writes come from the seam's handler, and `adopt()`
   * (the seam's promote) registers it like any inbound link. The read loop starts only after the seam has set the link up, so the
   * handler is in place before the first frame.
   */
  async #serveRestricted(duplex, who) {
    let podId;
    try { podId = fingerprintToPodId(who.fingerprint); } catch { duplex.destroy?.('bad identity'); return; }
    if (who.username !== usernameForPodId(podId)) { duplex.destroy?.('identity mismatch'); return; }
    const conn = this.#newConn({ role: 'host', podId, initiatorPodId: podId, duplex });
    const done = new Promise((resolve) => { conn.onEnd = resolve; });
    conn.writer = duplex.writable.getWriter();
    conn.reader = duplex.readable.getReader();
    conn.restricted = { sink: null, onClose: null };
    this.#restricted.add(conn);
    const channel = {
      send: (frame) => {
        let bytes;
        try { bytes = encodeFrame(frame, { maxFrameBytes: this.#maxFrame }); } catch (err) {
          return Promise.reject(err instanceof WshFrameError ? new WshLinkError(err.code, err.message, { podId, cause: err }) : err);
        }
        return this.#enqueue(conn, bytes);
      },
      onFrame: (cb) => { conn.restricted.sink = cb; },
      onClose: (cb) => { conn.restricted.onClose = cb; },
      close: (reason) => this.#end(conn, reason ?? 'admission-closed'),
      adopt: () => {
        if (conn.ended || !conn.restricted) return;
        conn.restricted = null;
        this.#restricted.delete(conn);
        this.#register(conn);
      },
    };
    let admitted;
    try {
      admitted = this.#admission.admit({ peerKey: podId, transport: 'wsh', proven: true, channel });
    } catch (e) {
      this.#onLog(`admission.admit threw: ${e?.message ?? e}`);
      this.#end(conn, 'admission-error');
    }
    // Reading starts at once, without waiting for admit() to settle: it has called the handler synchronously.
    if (!conn.ended) void this.#readLoop(conn);
    Promise.resolve(admitted).catch((e) => {
      this.#onLog(`admission.admit failed: ${e?.message ?? e}`);
      this.#end(conn, 'admission-error');
    });
    await done;
  }

  // -- Dialling (the reaching side's link) --------------------------------------

  #dial(podId) {
    const existing = this.#dials.get(podId);
    if (existing) return existing;
    const p = this.#doDial(podId).finally(() => { if (this.#dials.get(podId) === p) this.#dials.delete(podId); });
    this.#dials.set(podId, p);
    return p;
  }

  async #doDial(podId) {
    if (this.#beforeDial) await this.#beforeDial({ podId });
    if (!this.#relays.length) throw new WshLinkError('WSH_UNREACHABLE', 'no relay configured', { podId });
    let last = null;
    for (const relay of this.#relays) {
      try {
        const conn = await this.#dialRelay(relay, podId);
        this.#register(conn);
        return;
      } catch (err) {
        last = err;
        if (FATAL.has(err.code)) throw err;
      }
    }
    throw last;
  }

  async #dialRelay(relay, podId) {
    const cred = await this.#credReady;
    const rid = await rendezvousId(podId);
    const { WshClient, WebSocketTransport } = await loadClient();
    const hub = this;
    let socket = null;
    class PipeSocket {
      constructor() {
        socket = hub.#openSocket('operator', rid, relay);
        return socket;
      }
    }
    const client = new WshClient({
      transportFactories: {
        ws: () => new WebSocketTransport({ WebSocket: PipeSocket }),
        wt: () => { throw new Error('WebTransport is not used for mesh links'); },
      },
      ...this.#keepAlive,
    });
    const conn = this.#newConn({ role: 'operator', podId, initiatorPodId: cred.podId, client });
    client.onError = (err) => {
      if (/seal|did not open|decrypt/i.test(String(err?.message ?? err))) conn.endReason = 'seal-failed';
      conn.lastError = err;
    };
    client.onClose = () => this.#end(conn, conn.endReason ?? 'transport');

    const attempt = (async () => {
      await client.connect(pipeUrl(relay, rid, 'operator'), {
        username: usernameForPodId(cred.podId),
        ...(cred.keyPair ? { keyPair: cred.keyPair } : { signer: cred.signer }),
        transport: 'ws',
        expectHostKey: podIdToFingerprint(podId),
        sealSession: true,
        requireChannelBinding: true,
        timeout: this.#connectTimeoutMs,
      });
      if (!client.sessionSealed) throw new WshLinkError('WSH_NOT_SEALED', `the session with ${podId} is not sealed`, { podId, reason: 'not-sealed' });
      try {
        conn.duplex = await client.openEndpoint(ENDPOINT);
      } catch (err) {
        // A host that logged this key in as RESTRICTED granted it only the admission endpoint: wsh refuses `mesh` by policy.
        // Any other failure, or a host with no such endpoint, is the original error.
        if (!/POLICY_DENIED|denied|not permitted|refus|capabilit/i.test(`${err?.code ?? ''} ${err?.name ?? ''} ${err?.message ?? ''}`)) throw err;
        try { conn.duplex = await client.openEndpoint(ADMISSION_ENDPOINT); } catch { throw err; }
      }
    })();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new WshLinkError('WSH_UNREACHABLE', `${podId} did not answer within ${this.#connectTimeoutMs} ms`, { podId })), this.#connectTimeoutMs);
    });
    try {
      await Promise.race([attempt, timeout]);
    } catch (err) {
      attempt.catch(() => {});
      client.onClose = null;
      conn.ended = true;
      client.disconnect().catch(() => {});
      try { socket?.close(); } catch { /* already closed */ }
      throw mapDialError(err, podId);
    } finally {
      clearTimeout(timer);
    }
    return conn;
  }

  // -- Connections ----------------------------------------------------------------

  #newConn({ role, podId, initiatorPodId, duplex = null, client = null }) {
    return {
      id: this.#nextConnId++, role, podId, initiatorPodId, duplex, client, writer: null, reader: null,
      queue: [], queued: 0, pumping: false, idle: [], ended: false, superseded: false, pause: null, endReason: null, onEnd: null, lastError: null,
      restricted: null, reading: false, decoder: null,
    };
  }

  /** Make a freshly authenticated connection the peer's link, or the loser of the tie-break. */
  #register(conn) {
    let entry = this.#peers.get(conn.podId);
    if (!entry) this.#peers.set(conn.podId, (entry = { active: null, all: new Set() }));
    conn.writer ??= conn.duplex.writable.getWriter();
    conn.reader ??= conn.duplex.readable.getReader();
    entry.all.add(conn);
    this.#stats.linksEstablished++;
    const current = entry.active;
    if (!current) {
      entry.active = conn;
      const w = this.#wanted.get(conn.podId);
      if (w) w.attempts = 0;
      this.#emit('peer-up', { podId: conn.podId, initiator: conn.role === 'operator' ? 'local' : 'remote' });
    } else {
      let winner;
      if (conn.initiatorPodId === current.initiatorPodId) winner = conn; // a redial racing a link not yet noticed as dead
      else winner = initiatorWins(conn.initiatorPodId, current.initiatorPodId) ? conn : current;
      const loser = winner === conn ? current : conn;
      entry.active = winner;
      void this.#supersede(loser);
    }
    if (!conn.reading) void this.#readLoop(conn);
  }

  async #supersede(conn) {
    if (conn.superseded || conn.ended) return;
    conn.superseded = true;
    this.#stats.superseded++;
    const grace = setTimeout(() => this.#end(conn, 'superseded'), this.#supersedeGraceMs);
    grace.unref?.();
    conn.graceTimer = grace;
    try {
      // Let what is already queued go out, then half close: the peer sees the end and finishes.
      await new Promise((resolve) => {
        if (!conn.queue.length && !conn.pumping) resolve();
        else conn.idle.push(resolve);
      });
      if (!conn.ended) await conn.writer.close();
    } catch { /* the link may already be gone */ }
  }

  async #readLoop(conn) {
    conn.reading = true;
    const decoder = (conn.decoder ??= new FrameDecoder({ maxFrameBytes: this.#maxFrame }));
    let reason = conn.endReason ?? 'closed';
    let error = null;
    try {
      for (;;) {
        if (conn.pause) await conn.pause.promise;
        if (conn.ended) return;
        const { value, done } = await conn.reader.read();
        if (done) break;
        for (const frame of decoder.push(value)) {
          if (conn.pause) await conn.pause.promise; // paused while this read was in flight: hold the frame
          if (conn.ended) return;
          if (conn.restricted) {
            // A restricted link's frames belong to the admission seam and to nothing else.
            try { await conn.restricted.sink?.(frame); } catch (e) { this.#onLog(`restricted frame handler threw: ${e?.message ?? e}`); }
            if (conn.ended) return;
            continue;
          }
          this.#stats.messagesIn++;
          this.#stats.bytesIn += typeof frame === 'string' ? frame.length : frame.length;
          const handlers = this.#emit('message', { from: conn.podId, data: frame });
          const pending = handlers.filter((h) => h && typeof h.then === 'function');
          if (pending.length) await Promise.allSettled(pending);
          if (conn.ended) return;
        }
      }
      decoder.end();
    } catch (err) {
      if (err instanceof WshFrameError) {
        reason = err.code === 'WSH_FRAME_TOO_LARGE' ? 'frame-too-large' : 'bad-frame';
        error = new WshLinkError(err.code, err.message, { podId: conn.podId, cause: err });
        this.#stats.dropped++;
        this.#emit('dropped', { from: conn.podId, reason });
        this.#fail(error, { podId: conn.podId });
      } else {
        reason = conn.endReason ?? 'transport';
        error = err;
      }
    }
    this.#end(conn, conn.endReason ?? reason, error);
  }

  #enqueue(conn, frame) {
    if (conn.ended) return Promise.reject(new WshLinkError('WSH_CLOSED', `the link to ${conn.podId} is closed`, { podId: conn.podId }));
    if (conn.queued + frame.length > this.#maxQueued) {
      return Promise.reject(new WshLinkError('WSH_BACKPRESSURE', `the send queue to ${conn.podId} is full (${this.#maxQueued} bytes); the peer is not reading`, { podId: conn.podId }));
    }
    return new Promise((resolve, reject) => {
      conn.queue.push({ frame, resolve, reject });
      conn.queued += frame.length;
      this.#pump(conn);
    });
  }

  #pump(conn) {
    if (conn.pumping) return;
    conn.pumping = true;
    (async () => {
      try {
        while (conn.queue.length && !conn.ended) {
          const item = conn.queue[0];
          await conn.writer.write(item.frame);
          conn.queue.shift();
          conn.queued -= item.frame.length;
          this.#stats.messagesOut++;
          this.#stats.bytesOut += item.frame.length;
          item.resolve();
        }
      } catch (err) {
        this.#end(conn, conn.endReason ?? 'transport', err);
      } finally {
        conn.pumping = false;
        for (const resolve of conn.idle.splice(0)) resolve();
      }
    })();
  }

  /** A connection is over. */
  #end(conn, reason, error = null) {
    if (conn.ended) return;
    conn.ended = true;
    clearTimeout(conn.graceTimer);
    if (reason === 'seal-failed' && !(error instanceof WshLinkError)) {
      error = new WshLinkError('WSH_SEAL_FAILED', `a sealed frame from ${conn.podId} did not open; the link was ended`, { podId: conn.podId, cause: error ?? undefined });
      if (!conn.superseded) this.#fail(error, { podId: conn.podId });
    }
    const closed = new WshLinkError('WSH_CLOSED', `the link to ${conn.podId} closed (${reason})`, { podId: conn.podId });
    for (const item of conn.queue) item.reject(closed);
    conn.queue = [];
    conn.queued = 0;
    if (conn.pause) { conn.pause.resolve(); conn.pause = null; }
    try { conn.reader?.cancel().catch(() => {}); } catch { /* ignore */ }
    try { conn.duplex?.destroy?.(reason); } catch { /* ignore */ }
    if (conn.client) { conn.client.onClose = null; conn.client.disconnect().catch(() => {}); }
    if (conn.restricted) {
      const { onClose } = conn.restricted;
      conn.restricted = null;
      try { onClose?.(reason); } catch { /* a seam callback may not break the close */ }
    }
    this.#restricted.delete(conn);
    conn.onEnd?.();
    const entry = this.#peers.get(conn.podId);
    if (!entry) return;
    entry.all.delete(conn);
    if (conn.superseded || entry.active !== conn) {
      if (!entry.all.size && !entry.active) this.#peers.delete(conn.podId);
      return;
    }
    void this.#afterActiveEnded(conn, entry, reason, error);
  }

  async #afterActiveEnded(conn, entry, reason, error) {
    const alt = [...entry.all].find((c) => !c.ended && !c.superseded);
    if (alt) { entry.active = alt; return; }
    entry.active = null;
    const dial = this.#dials.get(conn.podId);
    if (dial) {
      // A dial is in flight: if it lands, this was a hand over, not a departure.
      await dial.catch(() => {});
      if (entry.active) return;
    }
    if (this.#peers.get(conn.podId) === entry && !entry.all.size) this.#peers.delete(conn.podId);
    const detail = { podId: conn.podId, reason };
    if (error) detail.error = error;
    this.#emit('peer-down', detail);
    if (reason !== 'local-close' && !this.#closed) this.#scheduleRedial(conn.podId);
  }

  // -- Redial -----------------------------------------------------------------------

  #want(podId) { if (!this.#wanted.has(podId)) this.#wanted.set(podId, { attempts: 0, timer: null }); }

  #unwant(podId) {
    const w = this.#wanted.get(podId);
    if (w) { clearTimeout(w.timer); this.#wanted.delete(podId); }
  }

  #scheduleRedial(podId) {
    const w = this.#wanted.get(podId);
    if (!w || w.timer || this.#closed) return;
    if (w.attempts >= this.#reconnect.maxAttempts) return;
    const delay = Math.min(this.#reconnect.baseMs * 2 ** w.attempts, this.#reconnect.maxMs);
    w.attempts++;
    w.timer = setTimeout(async () => {
      w.timer = null;
      if (this.#closed || !this.#wanted.has(podId) || this.isConnected(podId)) return;
      try {
        await this.#dial(podId);
      } catch (err) {
        if (FATAL.has(err.code)) { this.#unwant(podId); this.#fail(err, { podId }); } else this.#scheduleRedial(podId);
      }
    }, delay);
    w.timer.unref?.();
  }
}

// ---------------------------------------------------------------------------
// WshLink: a transport object for one peer
// ---------------------------------------------------------------------------

const LINK_EVENTS = ['open', 'message', 'close', 'error'];

/**
 * One peer's link shaped like the other mesh transports: `type`, `state`,
 * `connected`, `connect()`, `send()`, `close()`, `on(event, cb)`, plus
 * `onMessage` / `onClose` / `onError` for `PeerNode`. It is a view of the hub's
 * link to that peer, so a redial or a tie-break switch is invisible to it.
 */
export class WshLink {
  #hub;
  #peer;
  #cbs = { open: [], message: [], close: [], error: [] };
  #unsubs = [];
  #closed = false;
  #connecting = false;

  /**
   * @param {WshPeerLinks} hub
   * @param {string} peerPodId
   */
  constructor(hub, peerPodId) {
    if (!(hub instanceof WshPeerLinks)) throw new TypeError('WshLink needs the WshPeerLinks it belongs to');
    podIdToFingerprint(peerPodId);
    this.#hub = hub;
    this.#peer = peerPodId;
    this.#unsubs.push(
      hub.on('message', ({ from, data }) => {
        if (from !== this.#peer) return undefined;
        const out = this.#fire('message', data);
        const pending = out.filter((r) => r && typeof r.then === 'function');
        return pending.length ? Promise.allSettled(pending) : undefined;
      }),
      hub.on('peer-up', ({ podId }) => { if (podId === this.#peer) this.#fire('open'); }),
      hub.on('peer-down', ({ podId, reason, error }) => { if (podId === this.#peer) this.#fire('close', { reason, error }); }),
      hub.on('error', ({ error, podId }) => { if (podId === this.#peer) this.#fire('error', error); }),
    );
  }

  get type() { return 'wsh'; }
  get peerPodId() { return this.#peer; }
  get sealed() { return true; }
  get fingerprint() { return podIdToFingerprint(this.#peer); }
  get latency() { return 0; }
  get connected() { return !this.#closed && this.#hub.isConnected(this.#peer); }
  get state() {
    if (this.#closed) return 'closed';
    if (this.#hub.isConnected(this.#peer)) return 'connected';
    return this.#connecting ? 'connecting' : 'disconnected';
  }

  async connect() {
    if (this.#closed) throw new WshLinkError('WSH_CLOSED', 'this link is closed', { podId: this.#peer });
    this.#connecting = true;
    try { await this.#hub.connect(this.#peer); } finally { this.#connecting = false; }
  }

  /** @returns {Promise<void>} resolves when the endpoint accepted the frame */
  send(data) {
    if (this.#closed) return Promise.reject(new WshLinkError('WSH_CLOSED', 'this link is closed', { podId: this.#peer }));
    return this.#hub.send(this.#peer, data);
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#hub.disconnect(this.#peer);
    for (const off of this.#unsubs) off();
    this.#unsubs = [];
  }

  /** Stop listening to the hub without closing the peer's link. */
  dispose() {
    for (const off of this.#unsubs) off();
    this.#unsubs = [];
    this.#closed = true;
  }

  on(event, cb) {
    if (!LINK_EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`);
    this.#cbs[event].push(cb);
  }

  onMessage(cb) { this.on('message', cb); }
  onClose(cb) { this.on('close', cb); }
  onError(cb) { this.on('error', cb); }

  getStats() { return this.#hub.getStats(); }

  toJSON() {
    return { type: 'wsh', state: this.state, peerPodId: this.#peer, sealed: true };
  }

  #fire(event, data) {
    const out = [];
    for (const cb of [...this.#cbs[event]]) {
      try { out.push(cb(data)); } catch { /* listener errors do not propagate */ }
    }
    return out;
  }
}

/**
 * A `MeshTransportNegotiator` adapter factory for `'wsh'`:
 * `negotiator.registerAdapter('wsh', createWshTransportFactory(links))`.
 * By the convention `createWebRTCTransportFactory` uses, the endpoint is the
 * remote peer's pod id. Wsh is never tried unless the negotiator is told to:
 * put `'wsh'` in its `preferenceOrder` or pass `require: 'wsh'`.
 *
 * @param {WshPeerLinks} links
 * @returns {(endpoint: string, auth?: object) => Promise<WshLink>}
 */
export function createWshTransportFactory(links) {
  if (!(links instanceof WshPeerLinks)) throw new TypeError('createWshTransportFactory needs a WshPeerLinks');
  return async (endpoint) => {
    const podId = typeof endpoint === 'string' ? endpoint : endpoint?.podId;
    const link = new WshLink(links, podId);
    try {
      await link.connect();
    } catch (err) {
      link.dispose();
      throw err;
    }
    return link;
  };
}
