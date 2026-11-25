/**
 * wsh-services.mjs -- a stock wsh client may use a pod's OBJECTS and MCP tools.
 *
 * Off unless asked for: nothing in this package or any other constructs `WshServices`. When it is
 * started, the pod listens at its OWN pipe-relay rendezvous id (`servicesRendezvousId`), apart from the
 * mesh link host (`WshPeerLinks`), as a wsh host that
 *
 *  - seals every session (`sealSession: 'require'`, login bound to the host key), with the pod's key as
 *    the host key, so a client pins the pod by its pod id;
 *  - admits a key only if the pod's REGISTRY grants `wsh-services:open` to the key's pod id (the hash of
 *    the key wsh authenticated). The user name is a label. Key lines, `authorized_keys` options and
 *    capability strings are not consulted: the host is given no `authorizedKeys` at all;
 *  - serves exactly two rpc channels and nothing else (no exec, pty, files, targets, endpoints or
 *    gateway exist on it): `mcp` (the page's WebMCP tools, wsh's bridge) and `wsh-objects` (wsh's
 *    object layer). Each needs its channel grant (`protocol:mcp:open`, `protocol:objects:open`) and
 *    asks the registry on EVERY request (`mcp:<tool>:list|call`, `objects:<root>:get|call|set|on`);
 *  - ends a session when the registry says the pod's access changed and `wsh-services:open` is gone;
 *  - audits every session and every refusal, and tells an indicator about each session. A session
 *    begins when wsh says it is SEALED (`onSealed`), not at login: on a host that requires sealing a
 *    login is told so (`who.sealRequired`), and a plain client that passes it is served nothing and is
 *    never listed, audited as a session or shown (its refusal is audited as a refusal).
 *
 * Design and threat model: docs/design/wsh-services-on-a-pod.md. `@johnhenry/wsh` (>= 0.49) is loaded
 * lazily on `start()`. The embedder's `indicator` is wsh's `{ connected, disconnected }` callbacks shape;
 * a page that wants wsh's own badge can pass `createPageIndicator(window, { name })`'s `show`/`hide`
 * through it (`connected: (who, control) => badge.show(who, control.stop)`, `disconnected: (who) => badge.hide(who)`).
 */

import { encodeBase64url } from '@johnhenry/browsermesh-primitives';
import { WshLinkError, resolveCredential, fingerprintToPodId, podIdToFingerprint } from './wsh-links.mjs';
import { loadWatchPairing, waitingHalf } from './wsh-pairing.mjs';

const RENDEZVOUS_LABEL = 'browsermesh-wsh-services/1:';

/**
 * The pipe relay rendezvous id a pod's wsh services listen at: base64url(SHA-256(label || pod id)).
 * Derived from a public value, so nothing relies on it being secret.
 * @param {string} podId
 * @returns {Promise<string>}
 */
export async function servicesRendezvousId(podId) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RENDEZVOUS_LABEL + podId));
  return encodeBase64url(new Uint8Array(hash));
}

/** The grants, as `[resource, action]` for `registry.checkAccess(podId, resource, action)`. */
export const WSH_SERVICES_GRANTS = Object.freeze({
  /** Log in at all. */
  open: Object.freeze(['wsh-services', 'open']),
  /** Open the `mcp` channel. */
  mcp: Object.freeze(['protocol:mcp', 'open']),
  /** Open the `wsh-objects` channel. */
  objects: Object.freeze(['protocol:objects', 'open']),
});

const MCP_RPC = 'mcp';
const OBJECTS_RPC = 'wsh-objects';
// Tool and root names that can sit in a scope: no ':' and no '*', so a name can never widen a grant.
const SCOPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** wsh's operation kinds, as the registry action each needs. */
const OBJECT_ACTION = Object.freeze({ get: 'get', describe: 'get', snapshot: 'get', call: 'call', construct: 'call', set: 'set', on: 'on' });

/**
 * The registry action an object operation needs (`objects:<root>:<action>`), or null for a kind this table does not
 * name (which is refused). The same table as `actionFor` of `@johnhenry/browsermesh-objects`: transport cannot depend on
 * that package, so a test in that package asserts the two agree.
 * @param {{ kind?: string }} op
 * @returns {'get'|'call'|'set'|'on'|null}
 */
export function wshObjectActionFor(op) {
  const kind = op?.kind;
  return typeof kind === 'string' && Object.hasOwn(OBJECT_ACTION, kind) ? OBJECT_ACTION[kind] : null;
}

let wshModule = null;
async function loadWsh() {
  if (wshModule) return wshModule;
  try {
    const [memory, page, duplex] = await Promise.all([import('@johnhenry/wsh/memory'), import('@johnhenry/wsh/page'), import('@johnhenry/wsh/duplex')]);
    // 0.50: `authorizesItself` (the registry, not a key capability, opens the two channels), `onSealed` and the per-tool `mcp-call` hook
    // (0.49), and `@johnhenry/wsh/duplex` (a session over a mesh channel).
    if (typeof page.webmcpTools !== 'function' || typeof page.exposeObjects !== 'function' || typeof duplex.serveWshOverDuplex !== 'function') {
      throw new Error('this @johnhenry/wsh is older than 0.50');
    }
    // `watchPairing` (wsh 0.54.1, with `accept(socket, { waitForPeer })`) is null for an older wsh: see wsh-pairing.mjs.
    wshModule = { createMemoryHost: memory.createMemoryHost, webmcpTools: page.webmcpTools, exposeObjects: page.exposeObjects, serveWshOverDuplex: duplex.serveWshOverDuplex, watchPairing: await loadWatchPairing() };
    return wshModule;
  } catch (cause) {
    throw new WshLinkError('WSH_UNAVAILABLE', `wsh services need @johnhenry/wsh 0.50 or later: ${cause?.message ?? cause}`, { cause });
  }
}

const realmTimers = () => ({
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
});

function pipeUrl(relay, id, role, notifyPaired = false) {
  const u = new URL(relay);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/r/${id}`;
  // `paired=1` asks a relay to tell a waiting host half when its client arrives (wsh 0.54.1); a relay that predates it ignores it.
  u.search = role === 'host' ? (notifyPaired ? '?role=host&paired=1' : '?role=host') : '';
  return u.toString();
}

/**
 * Dial a pod's wsh services over a mesh protocol channel, with the real wsh client: the pod is the host and its pod id is the host
 * key, so the client pins it (`expectHostKey` is the peer's fingerprint; naming another is refused). The session is sealed and the
 * login is bound to the host key (`connectWshOverDuplex`'s defaults).
 * @param {object} service the api of `attachService(node, undefined, createMeshProtocolService())`
 * @param {string} peer the pod id of the pod that serves the services
 * @param {object} credentials `connectWshOverDuplex`'s: `{ username, keyPair | signer, timeout }`
 * @param {{ protocol?: string, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns the `connectWshOverDuplex` result: `{ client, connected, close() }` (`connected` has resolved)
 */
export async function connectWshServicesOverMesh(service, peer, credentials = {}, { protocol = 'wsh', signal, timeoutMs } = {}) {
  const api = service?.api && typeof service.api.openProtocol === 'function' ? service.api : service;
  if (typeof api?.openProtocol !== 'function') throw new TypeError('connectWshServicesOverMesh: a protocol service is needed');
  const pin = podIdToFingerprint(peer);
  if (credentials.expectHostKey !== undefined && credentials.expectHostKey !== pin) throw new TypeError('connectWshServicesOverMesh: the host key of a pod is its pod id; another expectHostKey cannot be right');
  if (credentials.trustOnFirstUse || credentials.allowUnsealed) throw new TypeError('connectWshServicesOverMesh: the pod is pinned and the session is sealed; neither can be lifted here');
  const { connectWshOverDuplex } = await import('@johnhenry/wsh/duplex').catch((cause) => { throw new WshLinkError('WSH_UNAVAILABLE', `wsh over a mesh channel needs @johnhenry/wsh 0.50 or later: ${cause?.message ?? cause}`, { cause }); });
  let conn = null;
  const held = [];
  const deliver = (message) => { if (message instanceof Uint8Array) conn.receive(message); else conn.end('not bytes'); };
  // The host speaks first: what arrives before the client exists is held, in order.
  const channel = await api.openProtocol(peer, protocol, { signal, timeoutMs, setup: (ch) => { ch.onMessage((m) => { if (conn) deliver(m); else held.push(m); }); } });
  conn = connectWshOverDuplex(
    { send: (bytes) => channel.send(bytes), close: (reason) => { try { channel.close(reason); } catch { /* already closed */ } }, maxMessageBytes: channel.maxMessageBytes },
    { ...credentials, expectHostKey: pin },
  );
  channel.onClose(() => conn.end('channel closed'));
  for (const m of held.splice(0)) deliver(m);
  try { await conn.connected; } catch (e) { await conn.close().catch(() => {}); throw e; }
  return conn;
}

const DEFAULT_RECONNECT =Object.freeze({ baseMs: 250, maxMs: 10_000 });

/**
 * @typedef {object} WshServicesOptions
 * @property {object} identity a `PodIdentity`, or `{ podId, signer }` for a key held elsewhere: the pod's key is the host key
 * @property {string|string[]} relays pipe relay URL(s) (`ws(s)://` or `http(s)://`)
 * @property {object} registry a `PeerRegistry`: `checkAccess(podId, resource, action)` (boolean or `{ allowed }`) and `onAccessChange(cb)`
 * @property {{ tools?: object[], window?: object, allow: string[], approve?: string, prompt?: Function, capture?: object, limits?: object }} [mcp]
 *   serve the page's WebMCP tools (wsh's bridge; `allow` names what exists at all)
 * @property {{ roots: object, allow?: object, mode?: string, limits?: object, handles?: object, eventFields?: object }} [objects]
 *   serve objects (wsh's object layer; `authorize` is the registry's, not an option)
 * @property {{ connected(who: object, control: { stop(): Promise<boolean> }): void, disconnected(who: object): void }} [indicator]
 * @property {boolean} [unattended] nobody is in front of this pod: allows starting without an indicator
 * @property {(event: object) => void} [onAudit]
 * @property {string[]} [acceptVia] pod ids of relaying pods (`WshRelay`) allowed to carry a session over a mesh channel for a key that is not their own; empty by default (the key must be the channel peer's own)
 * @property {number} [maxSessions=4]
 * @property {number} [listenSlots=2]
 * @property {number} [bindTimeoutMs]
 * @property {number} [connectionTtlMs]
 * @property {number} [rpcMaxInflight]
 * @property {number} [rpcMaxMessageBytes]
 * @property {Function} [WebSocket] a WebSocket constructor (default: the global)
 * @property {Function} [socketFactory] `(url, { role, id, relay }) => socket`, in place of `new WebSocket(url)`
 * @property {{ baseMs?: number, maxMs?: number }} [reconnect] retry of a lost relay connection
 * @property {(line: string) => void} [onLog]
 */

export class WshServices {
  #opts;
  #registry;
  #cred = null;
  #credReady;
  #relays;
  #WebSocketCtor;
  #socketFactory;
  #maxSessions;
  #slotsWanted;
  #reconnect;
  #rid = null;
  #started = false;
  #stopped = false;
  #wsh = null;
  #mcp = null;
  #objects = null;
  #offAccess = null;
  /** @type {Map<string, Set<object>>} relay -> waiting/paired slots */
  #slots = new Map();
  #slotRetry = new Map();
  #slotAttempts = new Map();
  /** @type {Set<object>} */
  #sessions = new Set();
  #blocked = new Set();
  /** Logins that have passed but whose session wsh has not sealed yet: not sessions (not listed, audited or shown). */
  #unsealed = new Set();
  #acceptVia = new Set();
  /** Mesh channels being served (see `serveChannel`). */
  #channels = new Set();
  #pendingReasons = new Map();

  /** @param {WshServicesOptions} opts */
  constructor(opts = {}) {
    if (!opts.identity) throw new TypeError('WshServices requires { identity }');
    if (!opts.registry || typeof opts.registry.checkAccess !== 'function') throw new TypeError('WshServices requires { registry }: the pod\'s PeerRegistry (checkAccess, onAccessChange) is what permits a key; nothing else does');
    if (!opts.mcp && !opts.objects) throw new TypeError('WshServices needs at least one service: { mcp } and/or { objects }');
    if (opts.mcp && !Array.isArray(opts.mcp.allow)) throw new TypeError('WshServices: mcp.allow must list the tool names the page offers (nothing is offered by default)');
    if (opts.objects && (!opts.objects.roots || typeof opts.objects.roots !== 'object')) throw new TypeError('WshServices: objects.roots must name the roots that are reachable');
    if (opts.objects && 'authorize' in opts.objects) throw new TypeError('WshServices: objects.authorize is the registry\'s; it cannot be replaced');
    if (opts.indicator !== undefined && (typeof opts.indicator?.connected !== 'function' || typeof opts.indicator?.disconnected !== 'function')) throw new TypeError('WshServices: indicator needs connected() and disconnected()');
    this.#opts = opts;
    this.#registry = opts.registry;
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
    this.#acceptVia = new Set(opts.acceptVia ?? []);
    for (const via of this.#acceptVia) if (typeof via !== 'string' || !via) throw new TypeError('WshServices: acceptVia lists pod ids');
    this.#maxSessions = opts.maxSessions ?? 4;
    if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions < 1) throw new TypeError('maxSessions must be a positive integer');
    this.#slotsWanted = opts.listenSlots ?? 2;
    if (!Number.isSafeInteger(this.#slotsWanted) || this.#slotsWanted < 1) throw new TypeError('listenSlots must be a positive integer');
    this.#reconnect = { ...DEFAULT_RECONNECT, ...opts.reconnect };
  }

  /** The services' rendezvous id once started. */
  get rendezvousId() { return this.#rid; }
  /** Who is connected now. */
  get sessions() {
    return [...this.#sessions].map((s) => ({ podId: s.podId, fingerprint: s.fingerprint, username: s.username, since: s.since }));
  }
  get started() { return this.#started && !this.#stopped; }

  /**
   * Begin listening: keep `listenSlots` host halves waiting at the services rendezvous id on every relay.
   * Refuses unless an `indicator` was given or `unattended: true` (a pod nobody is watching).
   */
  async start() {
    if (this.#stopped) throw new WshLinkError('WSH_CLOSED', 'the wsh services were stopped');
    if (this.#started) return;
    if (!this.#opts.indicator && this.#opts.unattended !== true) {
      throw new TypeError('WshServices.start(): pass an indicator (the person at this page sees who is connected, and can stop them) or unattended: true');
    }
    this.#started = true;
    const cred = await this.#credReady;
    this.#rid = await servicesRendezvousId(cred.podId);
    this.#wsh = await loadWsh();
    this.#buildHandlers();
    if (typeof this.#registry.onAccessChange === 'function') {
      this.#offAccess = this.#registry.onAccessChange((change) => this.#recheck(change?.pubKey));
    }
    if (this.#stopped) return;
    await Promise.all(this.#relays.map((relay) => this.#fillSlots(relay)));
  }

  /** End every session, stop listening, and stop watching the registry. Idempotent. */
  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#offAccess?.();
    this.#offAccess = null;
    for (const t of this.#slotRetry.values()) clearTimeout(t);
    this.#slotRetry.clear();
    for (const session of [...this.#sessions]) await this.#end(session, 'stopped', 'the services were stopped');
    for (const duplex of [...this.#channels]) { try { duplex.close(); } catch { /* already closed */ } }
    this.#channels.clear();
    for (const set of this.#slots.values()) {
      for (const slot of set) { try { slot.host?.close(); } catch { /* already closed */ } try { slot.ws?.close(); } catch { /* already closed */ } }
      set.clear();
    }
  }

  // -- Authorisation: the registry, and only the registry ------------------------

  #can(podId, resource, action) {
    if (typeof podId !== 'string' || !podId) return false;
    try {
      const r = this.#registry.checkAccess(podId, resource, action);
      return r === true || r?.allowed === true;
    } catch { return false; }
  }

  #audit(event, fields = {}) {
    const fn = this.#opts.onAudit;
    if (!fn) return;
    try { fn({ event, at: Date.now(), ...fields }); } catch { /* the embedder's callback */ }
  }

  #log(line) { try { this.#opts.onLog?.(line); } catch { /* the embedder's callback */ } }

  /** `podId` of the key behind a wsh fingerprint, or null. */
  static #podIdOf(fingerprint) {
    try { return fingerprintToPodId(fingerprint); } catch { return null; }
  }

  // -- Handlers: wsh's own, gated by the registry --------------------------------

  #buildHandlers() {
    const { webmcpTools, exposeObjects } = this.#wsh;
    const { mcp, objects } = this.#opts;
    if (mcp) {
      const handler = webmcpTools({
        window: mcp.window ?? {},
        allow: mcp.allow,
        ...(mcp.tools ? { tools: mcp.tools } : {}),
        ...(mcp.approve !== undefined ? { approve: mcp.approve } : {}),
        ...(mcp.prompt !== undefined ? { prompt: mcp.prompt } : {}),
        ...(mcp.capture !== undefined ? { capture: mcp.capture } : {}),
        ...(mcp.limits ? { limits: mcp.limits } : {}),
        ...(mcp.server ? { server: mcp.server } : {}),
        ...(mcp.window?.setTimeout ? {} : { timers: mcp.timers ?? realmTimers() }),
        onCall: (e) => this.#audit('call', { ...e, podId: WshServices.#podIdOf(e.who?.fingerprint) }),
      });
      this.#mcp = { handler };
    }
    if (objects) {
      const handler = exposeObjects({
        roots: objects.roots,
        ...(objects.allow ? { allow: objects.allow } : {}),
        ...(objects.mode ? { mode: objects.mode } : {}),
        ...(objects.handles ? { handles: objects.handles } : {}),
        ...(objects.limits ? { limits: objects.limits } : {}),
        ...(objects.eventFields ? { eventFields: objects.eventFields } : {}),
        // Asked for every operation the page's allow-list let through: the registry, for the key's pod id.
        authorize: (who, op) => {
          const podId = WshServices.#podIdOf(who?.fingerprint);
          const action = wshObjectActionFor(op);
          if (!podId || !action || typeof op.root !== 'string' || !SCOPE_NAME.test(op.root)) return false;
          const allowed = this.#can(podId, `objects:${op.root}`, action);
          if (!allowed) this.#audit('object-refused', { podId, root: op.root, kind: op.kind });
          return allowed;
        },
      });
      this.#objects = { handler };
    }
  }

  /**
   * The rpc handler of the `mcp` channel: wsh's bridge, behind the registry. The bridge asks `permits` for each tool, and says which
   * it is doing: listing (`mcp-tool`) or running (`mcp-call`), so each is its own grant (`mcp:<tool>:list`, `mcp:<tool>:call`) with
   * no wrapper around the bridge. The channel grant and `wsh-services:open` are asked again at the same moments.
   */
  #mcpHandler() {
    const { handler } = this.#mcp;
    const scoped = (channel, ctx = {}) => {
      const podId = WshServices.#podIdOf(ctx.fingerprint);
      const stillOpen = () => {
        if (this.#can(podId, ...WSH_SERVICES_GRANTS.mcp) && this.#can(podId, ...WSH_SERVICES_GRANTS.open)) return true;
        void channel.close('access revoked');
        return false;
      };
      if (!stillOpen()) { this.#audit('channel-refused', { podId, channel: MCP_RPC }); return; }
      handler(channel, {
        user: ctx.user ?? null,
        fingerprint: ctx.fingerprint ?? null,
        permits: (request) => {
          const action = request?.kind === 'mcp-call' ? 'call' : request?.kind === 'mcp-tool' ? 'list' : null;
          return action !== null && SCOPE_NAME.test(request.tool ?? '') && stillOpen() && this.#can(podId, `mcp:${request.tool}`, action);
        },
      });
    };
    // The registry decides, not a capability on the key: wsh opens this channel for any key it let in, and `stillOpen()` is the channel grant.
    scoped.authorizesItself = true;
    return scoped;
  }

  /** The rpc handler of the `wsh-objects` channel: the channel grant, then wsh's object layer behind per-root grants. */
  #objectsHandler() {
    const { handler } = this.#objects;
    const opened = (channel, ctx = {}) => {
      const podId = WshServices.#podIdOf(ctx.fingerprint);
      if (!this.#can(podId, ...WSH_SERVICES_GRANTS.objects)) {
        this.#audit('channel-refused', { podId, channel: OBJECTS_RPC });
        void channel.close('not permitted');
        return;
      }
      handler(channel, { user: ctx.user ?? null, fingerprint: ctx.fingerprint ?? null });
    };
    // The registry decides (here and for every root and operation), not a capability on the key.
    opened.authorizesItself = true;
    return opened;
  }

  // -- Hosts: one per waiting half, so a session can be ended on its own ---------

  #makeHost(slot) {
    const { createMemoryHost } = this.#wsh;
    const cred = this.#cred;
    const rpc = {};
    if (this.#mcp) rpc[MCP_RPC] = this.#mcpHandler();
    if (this.#objects) rpc[OBJECTS_RPC] = this.#objectsHandler();
    return createMemoryHost({
      hostKey: cred.keyPair ?? cred.signer,
      dataStreams: false,
      sealSession: 'require',
      requireChannelBinding: true,
      // wsh counts its login deadline (60 s by default) from the moment the host accepts a socket. A host half at a pipe relay is accepted
      // when it reaches the relay, long before a client pairs with it: from wsh 0.54.1 each such half is accepted with `waitForPeer`
      // (below), so the deadline runs from the client's arrival. With an older wsh there is no such option (0.54.0 would close every idle
      // half each minute), so those halves carry no deadline. A mesh channel is served from the moment its peer opens it and keeps
      // wsh's default.
      ...(slot.peer === undefined && !this.#wsh.watchPairing ? { loginTimeoutMs: 0 } : {}),
      auth: (who) => this.#login(who, slot),
      onSealed: () => this.#sealed(slot),
      // Only these rpc channels exist on this host: no exec, pty, fs, targets, endpoints or gateway.
      rpc,
      ...(this.#opts.rpcMaxInflight ? { rpcMaxInflight: this.#opts.rpcMaxInflight } : {}),
      ...(this.#opts.rpcMaxMessageBytes ? { rpcMaxMessageBytes: this.#opts.rpcMaxMessageBytes } : {}),
      ...(this.#opts.bindTimeoutMs ? { bindTimeoutMs: this.#opts.bindTimeoutMs } : {}),
      ...(this.#opts.connectionTtlMs ? { connectionTtlMs: this.#opts.connectionTtlMs } : {}),
      onRefused: (r) => this.#onRefused(r),
      onLog: (line) => this.#log(line),
    });
  }

  /** The login decision: the key's pod id and the registry. Returns what wsh needs to know of the key, or false. */
  async #login(who, slot) {
    const podId = WshServices.#podIdOf(who.fingerprint);
    if (!podId) return false;
    const refuse = (reason) => { this.#pendingReasons.set(who.fingerprint, reason); return false; };
    if (this.#stopped) return refuse('stopped');
    // Over a mesh channel the peer is verified by the mesh: the key that logs in must be that peer's own (a login for someone else's key is a relayed one).
    // (The one exception is a relaying pod this pod lists in `acceptVia`: it carries a session it cannot read, for a key that is not its own.)
    if (slot.peer !== undefined && podId !== slot.peer && !this.#acceptVia.has(slot.peer)) return refuse('not-the-channel-peer');
    if (this.#blocked.has(podId)) return refuse('stopped-by-indicator');
    // A login that is waiting to be sealed holds a place too: the bound is on what could become a session.
    if (this.#sessions.size + this.#unsealed.size >= this.#maxSessions) return refuse('too-many-sessions');
    if (!this.#can(podId, ...WSH_SERVICES_GRANTS.open)) return refuse('no-grant');
    // What wsh itself lets the key open: only the channels this pod's registry granted, and never anything else.
    // The key names NO capability: it may do nothing at wsh's level except open the two handlers below, which authorize for themselves
    // (`authorizesItself`, wsh 0.50): each asks the registry for its channel grant when it opens and for every tool or root after.
    const capabilities = [];
    const session = { podId, fingerprint: who.fingerprint, username: String(who.username ?? ''), since: Date.now(), slot, ended: false, sealed: false };
    slot.session = session;
    // On a host that requires sealing a login is not yet a session that can do anything: it is listed, audited and shown once `onSealed`
    // says the session is sealed (a plain client that passes login on such a host is served nothing and is never any of those).
    if (who.sealRequired === true) this.#unsealed.add(session);
    else this.#open(session);
    return { capabilities };
  }

  /** wsh sealed this login's session: from here it is a session. */
  #sealed(slot) {
    const session = slot.session;
    if (!session || session.ended || session.sealed) return;
    this.#unsealed.delete(session);
    if (this.#stopped || this.#blocked.has(session.podId) || !this.#can(session.podId, ...WSH_SERVICES_GRANTS.open)) {
      // Taken away between login and sealing.
      this.#audit('refused', { reason: this.#stopped ? 'stopped' : this.#blocked.has(session.podId) ? 'stopped-by-indicator' : 'no-grant', podId: session.podId, fingerprint: session.fingerprint });
      session.ended = true;
      try { slot.host?.close(); } catch { /* already closed */ }
      try { slot.ws?.close(); } catch { /* already closed */ }
      return;
    }
    this.#open(session);
  }

  #open(session) {
    session.sealed = true;
    this.#sessions.add(session);
    this.#audit('session-open', { podId: session.podId, fingerprint: session.fingerprint, username: session.username, ...(session.slot.peer !== undefined && session.slot.peer !== session.podId ? { via: session.slot.peer } : {}) });
    try {
      this.#opts.indicator?.connected({ username: session.username, fingerprint: session.fingerprint }, { stop: () => this.#stopSession(session) });
    } catch (e) { this.#log(`indicator.connected threw: ${e?.message ?? e}`); }
  }

  #onRefused({ reason, who, detail }) {
    const own = who?.fingerprint ? this.#pendingReasons.get(who.fingerprint) : undefined;
    if (own) this.#pendingReasons.delete(who.fingerprint);
    this.#audit('refused', { reason: own ?? reason, podId: who?.fingerprint ? WshServices.#podIdOf(who.fingerprint) : null, fingerprint: who?.fingerprint ?? null, detail });
  }

  async #stopSession(session) {
    if (session.ended) return false;
    this.#blocked.add(session.podId);
    await this.#end(session, 'stopped', 'stopped by the person at this page');
    return true;
  }

  /** The registry says a pod's access changed: end the sessions of pods that may no longer log in. */
  #recheck(podId) {
    for (const session of [...this.#sessions, ...this.#unsealed]) {
      if (podId !== undefined && session.podId !== podId) continue;
      if (this.#can(session.podId, ...WSH_SERVICES_GRANTS.open)) continue;
      void this.#end(session, 'revoked', 'access revoked');
    }
  }

  async #end(session, reason, tell) {
    if (session.ended) return;
    session.ended = true;
    this.#sessions.delete(session);
    if (!session.sealed) {
      // A login that never became a session: nothing was audited or shown when it began, so nothing is when it ends.
      this.#unsealed.delete(session);
      try { session.slot.host?.close(); } catch { /* already closed */ }
      try { session.slot.ws?.close(); } catch { /* already closed */ }
      return;
    }
    if (tell) {
      // Tell the client why, then end its session.
      await Promise.allSettled([
        this.#mcp?.handler.closeSessions(tell, session.fingerprint),
        this.#objects?.handler.closeSessions(tell, session.fingerprint),
      ]);
    }
    try { session.slot.host?.close(); } catch { /* already closed */ }
    try { session.slot.ws?.close(); } catch { /* already closed */ }
    this.#audit('session-close', { podId: session.podId, fingerprint: session.fingerprint, reason });
    try { this.#opts.indicator?.disconnected({ username: session.username, fingerprint: session.fingerprint }); } catch (e) { this.#log(`indicator.disconnected threw: ${e?.message ?? e}`); }
  }

  // -- A mesh protocol channel as the duplex ---------------------------------------

  /**
   * Serve ONE mesh protocol channel (its raw messages are the duplex of wsh's `serveWshOverDuplex`): the same host, the same sealed-only rule,
   * the same grants and audit as over a pipe relay, plus: the key that logs in must be the channel's verified peer's own. Needs `start()`.
   * @param {object} channel a protocol channel (`send`, `onMessage`, `onClose`, `close`, `peer`, `maxMessageBytes`)
   */
  serveChannel(channel) {
    if (!this.#started || this.#stopped) throw new WshLinkError('WSH_CLOSED', 'serveChannel needs started wsh services');
    if (typeof channel?.send !== 'function' || typeof channel.onMessage !== 'function' || typeof channel.peer !== 'string') throw new TypeError('serveChannel: a protocol channel is needed');
    const slot = { ws: null, host: null, paired: true, session: null, peer: channel.peer };
    const duplex = this.#wsh.serveWshOverDuplex(this.#makeHost(slot), {
      // The channel's own credit is the backpressure: its send promise is returned, so the next message waits for it.
      send: (bytes) => channel.send(bytes),
      close: (reason) => { try { channel.close(reason); } catch { /* already closed */ } },
      maxMessageBytes: channel.maxMessageBytes,
    });
    slot.host = null;
    duplex.ready.then((host) => { slot.host = host; }, (e) => this.#log(`accept over a mesh channel failed: ${e?.message ?? e}`));
    slot.ws = { close: () => duplex.close() };
    channel.onMessage((message) => { if (message instanceof Uint8Array) duplex.receive(message); else duplex.end('not bytes'); });
    this.#channels.add(duplex);
    channel.onClose(() => {
      this.#channels.delete(duplex);
      duplex.end('channel closed');
      if (slot.session) void this.#end(slot.session, 'closed');
    });
    return duplex;
  }

  /**
   * Offer the services on a protocol of a mesh node's protocol service (`attachService(node, undefined, createMeshProtocolService()).api`).
   * Who may open the channel is the protocol host's rule: `protocol:<name>:open` in the registry, default deny. Returns what stops it.
   * @param {{ serveProtocol(name: string, handler: Function): () => void }} service
   * @param {{ protocol?: string }} [options]
   */
  serveOnMesh(service, { protocol = 'wsh' } = {}) {
    const api = service?.api && typeof service.api.serveProtocol === 'function' ? service.api : service;
    if (typeof api?.serveProtocol !== 'function') throw new TypeError('serveOnMesh: a protocol service is needed');
    return api.serveProtocol(protocol, (channel) => { this.serveChannel(channel); });
  }

  // -- Listening: waiting host halves ---------------------------------------------

  #openSocket(role, id, relay) {
    const url = pipeUrl(relay, id, role, role === 'host' && Boolean(this.#wsh?.watchPairing));
    if (this.#socketFactory) return this.#socketFactory(url, { role, id, relay });
    if (!this.#WebSocketCtor) throw new WshLinkError('WSH_UNAVAILABLE', 'no WebSocket constructor: pass { WebSocket } or run where one is global');
    return new this.#WebSocketCtor(url);
  }

  async #fillSlots(relay) {
    if (this.#stopped || !this.#started) return;
    let set = this.#slots.get(relay);
    if (!set) this.#slots.set(relay, (set = new Set()));
    const opening = [];
    while (set.size < this.#slotsWanted) opening.push(this.#openSlot(relay, set));
    await Promise.all(opening);
  }

  async #openSlot(relay, set) {
    const slot = { ws: null, host: null, paired: false, session: null };
    set.add(slot);
    let opened = false;
    try {
      const ws = this.#openSocket('host', this.#rid, relay);
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
          set.delete(slot);
          if (slot.session) void this.#end(slot.session, 'closed');
          if (!slot.paired) this.#retrySlots(relay);
        });
        slot.host = this.#makeHost(slot);
        // The client is not here yet: wsh starts the login clock when it arrives (the relay's paired signal, else its first byte).
        const half = waitingHalf(ws, this.#wsh.watchPairing);
        void slot.host.accept(half.socket, half.options).catch((e) => this.#log(`accept failed: ${e?.message ?? e}`));
      }
    } catch (e) {
      this.#log(`could not open a host half at ${relay}: ${e?.message ?? e}`);
    }
    if (!opened) {
      set.delete(slot);
      this.#retrySlots(relay);
    }
  }

  #retrySlots(relay) {
    if (this.#stopped || this.#slotRetry.has(relay)) return;
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
}
