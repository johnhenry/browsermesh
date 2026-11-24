/**
 * wsh-relay.mjs -- a pod that carries another pod's wsh session to a target it can reach (a mesh `--via`).
 *
 * Off unless the embedder creates and starts a `WshRelay`, and then only for a requester whose registry grants include
 * `wsh-relay:<target>:open` for THAT target (default deny; a wildcard grant is refused unless `wideTargets: true`). The
 * target is a pod id (that pod's wsh services, reached over the mesh) or a name the operator mapped to a pipe relay URL and
 * rendezvous id: never an address the requester supplies, so this is not an open proxy.
 *
 * The relay never terminates wsh. It moves opaque byte messages between two duplexes (the requester's protocol channel and the
 * leg to the target) and nothing else: what it can see is who talks to whom, sizes, timing and the plain handshake; what it
 * can do is drop, delay or end. The end-to-end properties are wsh's: the client pins the target's host key.
 *
 * Design, bounds and threat model: docs/design/wsh-over-mesh.md ("The relaying pod").
 */

import { podIdToFingerprint } from '@johnhenry/browsermesh-primitives';
import { WshLinkError } from './wsh-links.mjs';

export const WSH_RELAY_PROTOCOL = 'wsh-relay';
const POD_ID = /^[A-Za-z0-9_-]{43}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const isPodId = (s) => {
  if (typeof s !== 'string' || !POD_ID.test(s)) return false;
  try { podIdToFingerprint(s); return true; } catch { return false; }
};

function pipeUrl(relay, id) {
  const u = new URL(relay);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/r/${id}`;
  u.search = '';
  return u.toString();
}

const DEFAULTS = Object.freeze({
  maxSessions: 2,
  maxBytes: 64 * 1024 * 1024,
  maxDurationMs: 60 * 60 * 1000,
  idleMs: 5 * 60 * 1000,
});

/**
 * @typedef {object} WshRelayOptions
 * @property {object} registry a `PeerRegistry`: `checkAccess(podId, resource, action)` and `onAccessChange(cb)`
 * @property {object} service the api of `attachService(node, undefined, createMeshProtocolService())`: serves the control protocol, opens the leg to a pod
 * @property {string} podId this pod's id (a request that names it is a loop)
 * @property {Record<string, { relay: string, id: string }>} [targets] names the operator maps to a pipe relay URL and rendezvous id
 * @property {boolean} [wideTargets] acknowledge wildcards: a `*` entry in `targets`, and a requester's `wsh-relay:*:open` grant
 * @property {number} [maxSessions=2]
 * @property {number} [maxBytes] per session, both directions together
 * @property {number} [maxDurationMs]
 * @property {number} [idleMs]
 * @property {{ connected(who: object, control: { stop(): Promise<boolean> }): void, disconnected(who: object): void }} [indicator]
 * @property {boolean} [unattended] nobody is in front of this pod: allows starting without an indicator
 * @property {(event: object) => void} [onAudit]
 * @property {Function} [WebSocket] for named targets (default: the global)
 * @property {string} [protocol='wsh-relay']
 */

export class WshRelay {
  #o;
  #registry;
  #service;
  #targets;
  #limits;
  #sessions = new Set();
  #stopServing = null;
  #offAccess = null;
  #started = false;
  #stopped = false;

  /** @param {WshRelayOptions} opts */
  constructor(opts = {}) {
    if (!opts.registry || typeof opts.registry.checkAccess !== 'function') throw new TypeError('WshRelay requires { registry }: the grants are the registry\'s');
    const api = opts.service?.api && typeof opts.service.api.serveProtocol === 'function' ? opts.service.api : opts.service;
    if (typeof api?.serveProtocol !== 'function' || typeof api.openProtocol !== 'function') throw new TypeError('WshRelay requires { service }: a mesh protocol service');
    if (!isPodId(opts.podId)) throw new TypeError('WshRelay requires { podId }: this pod\'s id');
    if (opts.indicator !== undefined && (typeof opts.indicator?.connected !== 'function' || typeof opts.indicator?.disconnected !== 'function')) throw new TypeError('WshRelay: indicator needs connected() and disconnected()');
    this.#targets = new Map();
    for (const [name, spec] of Object.entries(opts.targets ?? {})) {
      if (name === '*' || name.includes('*')) {
        if (opts.wideTargets !== true) throw new TypeError('WshRelay: a wildcard target would let a requester name anything; say so with wideTargets: true');
      } else if (!NAME.test(name) || POD_ID.test(name)) {
        throw new TypeError(`WshRelay: target name ${JSON.stringify(name)} must match ${NAME} and must not look like a pod id`);
      }
      let u;
      try { u = new URL(spec?.relay); } catch { throw new TypeError(`WshRelay: target ${name}: relay is not a URL`); }
      if (!/^(wss?|https?):$/.test(u.protocol)) throw new TypeError(`WshRelay: target ${name}: relay must be a ws(s) or http(s) URL`);
      if (typeof spec.id !== 'string' || !spec.id) throw new TypeError(`WshRelay: target ${name}: id is the rendezvous id`);
      this.#targets.set(name, { relay: spec.relay, id: spec.id });
    }
    this.#limits = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (opts[key] === undefined) continue;
      if (!Number.isSafeInteger(opts[key]) || opts[key] < 1) throw new TypeError(`WshRelay: ${key} must be a positive integer`);
      this.#limits[key] = opts[key];
    }
    if ((opts.protocol ?? WSH_RELAY_PROTOCOL) === 'wsh') throw new TypeError('WshRelay: the control protocol cannot be `wsh` (that is the services host a leg opens)');
    this.#o = opts;
    this.#registry = opts.registry;
    this.#service = api;
  }

  /** Relayed sessions now. */
  get sessions() { return [...this.#sessions].map((s) => ({ requester: s.requester, target: s.target, since: s.since, bytes: s.bytes })); }
  get started() { return this.#started && !this.#stopped; }

  /** Begin serving the control protocol. Refuses unless an indicator was given or `unattended: true`. */
  start() {
    if (this.#stopped) throw new WshLinkError('WSH_CLOSED', 'the relay was stopped');
    if (this.#started) return;
    if (!this.#o.indicator && this.#o.unattended !== true) throw new TypeError('WshRelay.start(): pass an indicator (the person at this pod sees what it relays, and can stop it) or unattended: true');
    this.#started = true;
    if (typeof this.#registry.onAccessChange === 'function') this.#offAccess = this.#registry.onAccessChange((change) => this.#recheck(change?.pubKey));
    this.#stopServing = this.#service.serveProtocol(this.#o.protocol ?? WSH_RELAY_PROTOCOL, (channel) => this.#accept(channel));
  }

  /** End every session and stop serving. */
  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    try { this.#stopServing?.(); } catch { /* already stopped */ }
    this.#offAccess?.();
    for (const s of [...this.#sessions]) this.#end(s, 'stopped');
  }

  #can(podId, resource) {
    try {
      const r = this.#registry.checkAccess(podId, resource, 'open');
      return r === true || r?.allowed === true;
    } catch { return false; }
  }

  #audit(event, fields = {}) {
    try { this.#o.onAudit?.({ event, at: Date.now(), ...fields }); } catch { /* the embedder's callback */ }
  }

  #recheck(podId) {
    for (const s of [...this.#sessions]) {
      if (podId !== undefined && s.requester !== podId) continue;
      if (!this.#can(s.requester, `wsh-relay:${s.target}`)) this.#end(s, 'revoked');
    }
  }

  /** The reason this request is refused, or null. Order: nothing is said about a target to a requester that has no grant for it. */
  #refusal(requester, message) {
    if (this.#stopped) return 'stopped';
    if (!message || typeof message !== 'object' || message.t !== 'open' || typeof message.target !== 'string') return 'bad-request';
    // A relayed session is not relayed onward: the marker is 0 on a requester's own request, and nothing else is accepted.
    if (message.hops !== 0) return 'chain';
    const { target } = message;
    if (!isPodId(target) && !NAME.test(target)) return 'bad-request';
    // A wildcard grant lets the requester name any pod: refused unless the operator said so. (The registry matches the literal `*` only
    // against a wildcard scope.)
    if (!this.#can(requester, `wsh-relay:${target}`)) return 'no-grant';
    if (this.#o.wideTargets !== true && this.#can(requester, 'wsh-relay:*')) return 'wildcard-grant';
    if (target === this.#o.podId || target === requester) return 'loop';
    if (!isPodId(target) && !this.#targets.has(target) && !this.#targets.has('*')) return 'unknown-target';
    if (this.#sessions.size >= this.#limits.maxSessions) return 'too-many-sessions';
    return null;
  }

  #accept(channel) {
    const requester = channel.peer;
    let session = null;
    let opened = false;
    const refuse = async (reason, target) => {
      this.#audit('relay-refused', { requester, target: typeof target === 'string' ? target.slice(0, 64) : undefined, reason });
      try { await channel.send({ t: 'refused', reason }); } catch { /* going away */ }
      try { channel.close(); } catch { /* already closed */ }
    };
    channel.onClose(() => { if (session) this.#end(session, 'requester-left'); });
    channel.onMessage(async (message) => {
      if (opened) {
        // After `ok` every message is opaque bytes for the leg; anything else ends the session.
        if (!(message instanceof Uint8Array)) { if (session) this.#end(session, 'not-bytes'); return undefined; }
        if (!session || session.ended || !session.fromRequester) return undefined;
        return session.fromRequester(message);
      }
      opened = true;
      const reason = this.#refusal(requester, message);
      if (reason) return refuse(reason, message?.target);
      const target = message.target;
      // Reserve the place before the leg is open, so two requests cannot both take the last one.
      session = { requester, target, since: Date.now(), bytes: 0, ended: false, leg: null, timers: [], fromRequester: null, channel };
      this.#sessions.add(session);
      let leg;
      try { leg = await this.#openLeg(target, session); } catch (e) {
        this.#sessions.delete(session);
        session.ended = true;
        // The protocol host allows one `wsh` channel per link: a second session to the same pod through this relay waits for the first.
        return refuse(/already open/.test(String(e?.message)) ? 'target-busy' : 'target-unreachable', target);
      }
      if (session.ended) { try { leg.close(); } catch { /* already closed */ } return undefined; }
      session.leg = leg;
      session.fromRequester = (bytes) => { this.#touch(session, bytes.byteLength); return leg.send(bytes); };
      this.#touch(session, 0);
      session.timers.push(setTimeout(() => this.#end(session, 'time-budget'), this.#limits.maxDurationMs));
      for (const t of session.timers) t.unref?.();
      this.#audit('relay-open', { requester, target });
      try {
        this.#o.indicator?.connected({ requester, target }, { stop: async () => { this.#end(session, 'stopped-by-indicator'); return true; } });
      } catch { /* the embedder's callback */ }
      try { await channel.send({ t: 'ok' }); } catch { this.#end(session, 'requester-left'); }
      return undefined;
    });
  }

  /** Count bytes, enforce the budget, and restart the idle timer. */
  #touch(session, bytes) {
    if (session.ended) return;
    session.bytes += bytes;
    if (session.bytes > this.#limits.maxBytes) { this.#end(session, 'byte-budget'); return; }
    clearTimeout(session.idle);
    session.idle = setTimeout(() => this.#end(session, 'idle'), this.#limits.idleMs);
    session.idle.unref?.();
  }

  #end(session, reason) {
    if (session.ended) return;
    session.ended = true;
    this.#sessions.delete(session);
    clearTimeout(session.idle);
    for (const t of session.timers) clearTimeout(t);
    try { session.leg?.close(); } catch { /* already closed */ }
    try { session.channel.close(); } catch { /* already closed */ }
    if (session.leg) {
      this.#audit('relay-close', { requester: session.requester, target: session.target, bytes: session.bytes, durationMs: Date.now() - session.since, reason });
      try { this.#o.indicator?.disconnected({ requester: session.requester, target: session.target }); } catch { /* the embedder's callback */ }
    }
  }

  /** The leg to the target: `{ send(bytes) -> Promise, close() }`; what the target sends goes back to the requester. */
  async #openLeg(target, session) {
    const toRequester = (bytes) => {
      if (session.ended) return undefined;
      this.#touch(session, bytes.byteLength);
      return session.ended ? undefined : session.channel.send(bytes);
    };
    if (isPodId(target)) {
      // Only ever the services protocol: never `wsh-relay`, so a relayed session cannot be relayed onward.
      const ch = await this.#service.openProtocol(target, 'wsh', {
        setup: (c) => { c.onMessage((m) => (m instanceof Uint8Array ? toRequester(m) : this.#end(session, 'not-bytes'))); },
      });
      ch.onClose(() => this.#end(session, 'target-left'));
      return { send: (bytes) => ch.send(bytes), close: () => { try { ch.close(); } catch { /* already closed */ } } };
    }
    const spec = this.#targets.get(target) ?? this.#targets.get('*');
    const Ctor = this.#o.WebSocket ?? globalThis.WebSocket;
    if (!Ctor) throw new WshLinkError('WSH_UNAVAILABLE', 'no WebSocket constructor: pass { WebSocket }');
    const ws = new Ctor(pipeUrl(spec.relay, spec.id));
    try { ws.binaryType = 'arraybuffer'; } catch { /* read-only on some sockets */ }
    await new Promise((resolve, reject) => {
      if (ws.readyState === 1) return resolve();
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('could not reach the target')), { once: true });
      ws.addEventListener('close', () => reject(new Error('could not reach the target')), { once: true });
    });
    ws.addEventListener('message', (e) => {
      const d = e.data;
      if (typeof d === 'string') return;
      void toRequester(d instanceof Uint8Array ? d : new Uint8Array(d.buffer ?? d, d.byteOffset ?? 0, d.byteLength));
    });
    ws.addEventListener('close', () => this.#end(session, 'target-left'));
    return { send: async (bytes) => { ws.send(bytes); }, close: () => { try { ws.close(); } catch { /* already closed */ } } };
  }
}

/**
 * Dial a target's wsh services THROUGH a relaying pod, with the real wsh client. The session is end to end with the target: the
 * client pins the target's host key (a pod id names it; a configured name needs `credentials.expectHostKey`, the fingerprint the
 * operator knows), so a relay that answers for the target is refused. Sealed; the relay cannot read or alter it.
 * @param {object} service the api of `attachService(node, undefined, createMeshProtocolService())`
 * @param {string} relay the pod id of the relaying pod
 * @param {string} target a pod id, or a name the relaying pod maps
 * @param {object} credentials `connectWshOverDuplex`'s
 * @param {{ protocol?: string, signal?: AbortSignal, timeoutMs?: number }} [options]
 */
export async function connectWshServicesViaRelay(service, relay, target, credentials = {}, { protocol = WSH_RELAY_PROTOCOL, signal, timeoutMs } = {}) {
  const api = service?.api && typeof service.api.openProtocol === 'function' ? service.api : service;
  if (typeof api?.openProtocol !== 'function') throw new TypeError('connectWshServicesViaRelay: a protocol service is needed');
  let pin;
  if (isPodId(target)) {
    pin = podIdToFingerprint(target);
    if (credentials.expectHostKey !== undefined && credentials.expectHostKey !== pin) throw new TypeError('connectWshServicesViaRelay: the host key of a pod is its pod id; another expectHostKey cannot be right');
  } else {
    if (typeof credentials.expectHostKey !== 'string' || !credentials.expectHostKey) throw new TypeError('connectWshServicesViaRelay: a named target needs credentials.expectHostKey (the host key the relay cannot choose)');
    pin = credentials.expectHostKey;
  }
  if (credentials.trustOnFirstUse || credentials.allowUnsealed) throw new TypeError('connectWshServicesViaRelay: the target is pinned and the session is sealed; neither can be lifted here');
  const { connectWshOverDuplex } = await import('@johnhenry/wsh/duplex').catch((cause) => { throw new WshLinkError('WSH_UNAVAILABLE', `wsh over a mesh channel needs @johnhenry/wsh 0.50 or later: ${cause?.message ?? cause}`, { cause }); });
  let conn = null;
  const held = [];
  let control;
  const answer = new Promise((resolve) => { control = resolve; });
  const channel = await api.openProtocol(relay, protocol, {
    signal,
    timeoutMs,
    setup: (ch) => {
      ch.onMessage((m) => {
        if (m instanceof Uint8Array) { if (conn) conn.receive(m); else held.push(m); } else if (m && typeof m === 'object' && !conn) control(m);
      });
    },
  });
  await channel.send({ t: 'open', target, hops: 0 });
  const reply = await Promise.race([answer, new Promise((resolve) => channel.onClose(() => resolve({ t: 'refused', reason: 'closed' })))]);
  if (reply.t !== 'ok') {
    // The relay closes the channel after a refusal; its close notice names the protocol only, so it is waited for here (bounded) rather
    // than left to land on the next channel opened under the same name.
    if (!channel.closed) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        timer.unref?.();
        channel.onClose(() => { clearTimeout(timer); resolve(); });
      });
    }
    try { channel.close(); } catch { /* already closed */ }
    throw new WshLinkError('WSH_RELAY_REFUSED', `the relay refused: ${reply.reason ?? 'no reason'}`, { reason: reply.reason });
  }
  conn = connectWshOverDuplex(
    { send: (bytes) => channel.send(bytes), close: (reason) => { try { channel.close(reason); } catch { /* already closed */ } }, maxMessageBytes: channel.maxMessageBytes },
    { ...credentials, expectHostKey: pin },
  );
  channel.onClose(() => conn.end('channel closed'));
  for (const m of held.splice(0)) conn.receive(m);
  try { await conn.connected; } catch (e) { await conn.close().catch(() => {}); throw e; }
  return conn;
}
