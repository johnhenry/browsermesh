/**
 * serve.mjs -- a page's WebMCP tools (or an explicit tool list) as the protocol `mcp` on a mesh node.
 *
 *   const service = attachService(node, undefined, createMeshProtocolService()).api
 *   const served = serveMcpOnMesh(service, { window, allow: ['search', 'buy'], approve: 'consequential' })
 *   node.registry.grantCapabilities(peerPodId, [...mcpScopes.open(), ...mcpScopes.tool('search')])
 *
 * What it decides, in order, on every request of every session:
 *   1. the channel opened at all: `protocol:mcp:open` (the protocol host's own check, default deny);
 *   2. the page offers the tool at all: `allow` (exact names, nothing by default);
 *   3. this peer may see it (`mcp:<tool>:list`) or call it (`mcp:<tool>:call`), through the registry,
 *      asked through wsh's own hook (`permits`): listing is `{ kind: 'mcp-tool', op: 'list' }`, a call
 *      `{ kind: 'mcp-call', op: 'call' }`, so the two are scoped apart without wrapping the handler;
 *   4. for a tool that is not read-only: the person at THIS page says yes (`approve`, `prompt`);
 *   5. bounds, by name (`limits`).
 * The peer is the channel's verified one, never a field of a message. The question to the person is the
 * serving page's: the caller cannot see, answer or influence it.
 *
 * The wire is plain MCP JSON-RPC 2.0 in the protocol channel's own messages (`serveMcpOverDuplex` of
 * `@johnhenry/wsh/page`): the channel's credit and ordering carry it, and an MCP client library can be
 * pointed straight at it.
 */
import { webmcpTools, serveMcpOverDuplex } from '@johnhenry/wsh/page'
import { podIdToFingerprint } from '@johnhenry/wsh/identity'
import { MCP_PROTOCOL, MCP_ACTIONS, TOOL_SCOPE_NAME } from './scopes.mjs'
import { createModernLayer } from './modern.mjs'

const realmTimers = () => ({
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
})

/** The largest message the seam accepts or sends: wsh's default, and never more than the channel carries. */
const MAX_MESSAGE_BYTES = 1024 * 1024

/**
 * Every result of a tool call is page content that may carry text written by third parties. wsh labels it
 * (`_meta['wsh/untrusted']`, which no tool can unset); this layer adds its own label beside it.
 */
function labelled(message) {
  const meta = message?.result?._meta
  return meta && meta['wsh/untrusted'] === true
    ? { ...message, result: { ...message.result, _meta: { ...meta, 'browsermesh/untrusted': true } } }
    : message
}

/** @param {any} service the api of `attachService(node, undefined, createMeshProtocolService())`, or the attached host itself */
function protocolApi(service) {
  const api = service?.api && typeof service.api.serveProtocol === 'function' ? service.api : service
  if (!api || typeof api.serveProtocol !== 'function') throw new TypeError('serveMcpOnMesh: first argument must be a protocol service (the api of attachService(node, undefined, createMeshProtocolService()))')
  return api
}

/**
 * @param {object} service see `protocolApi`
 * @param {object} options
 * @param {object} [options.window]  the realm whose WebMCP tools are served (a page's window, an iframe's, a fake one in a test)
 * @param {object[]} [options.tools] explicit tool definitions (as the page passes to `registerTool`); with no `window` these are all there is
 * @param {string[]} options.allow   exact tool names the page offers: nothing is offered by default
 * @param {'never'|'consequential'|'always'} [options.approve='consequential'] when the person at THIS page is asked
 * @param {Function} [options.prompt] `(call, who, { signal }) => boolean | Promise<boolean>`; default: a dialog in `window.document`, else deny
 * @param {object} [options.capture] a capture other than the one `captureWebMcp(window)` made
 * @param {object} [options.limits]  bounds, by name (see WEBMCP_DEFAULT_LIMITS)
 * @param {(peer: string, tool: string, action: 'list'|'call') => boolean} [options.authorize]
 *   Replaces the registry-backed decision (default: `service.rootAuthorizer('mcp')`, i.e. `PeerRegistry.checkAccess`).
 * @param {(event: object) => void} [options.onCall] audit: every call's outcome, and `unauthorized` for a grant that is missing
 * @param {(event: { peer: string, state: 'open'|'close' }) => void} [options.onSession] audit: a session opened or closed
 * @param {string} [options.protocol='mcp']
 * @param {() => number} [options.now]
 */
export function serveMcpOnMesh(service, options = {}) {
  const api = protocolApi(service)
  const {
    window, tools, allow, approve, prompt, capture, limits = {}, authorize, onCall, onSession, guard, server, timers,
    protocol = MCP_PROTOCOL, now = () => Date.now(),
  } = options
  if (window === undefined && !Array.isArray(tools)) throw new TypeError('serveMcpOnMesh: give a window (its WebMCP tools) or a tools array')
  if (!Array.isArray(allow)) throw new TypeError('serveMcpOnMesh: allow must be an array of tool names (nothing is offered by default)')
  if (authorize !== undefined && typeof authorize !== 'function') throw new TypeError('serveMcpOnMesh: authorize must be a function')
  if (onSession !== undefined && typeof onSession !== 'function') throw new TypeError('serveMcpOnMesh: onSession must be a function')

  const roots = authorize ? null : (typeof api.rootAuthorizer === 'function' ? api.rootAuthorizer(protocol, { actions: [...MCP_ACTIONS] }) : null)
  /** Default deny: no authorizer, a name that cannot sit in a scope, or any throw is a refusal. */
  const can = (peer, tool, action) => {
    if (typeof tool !== 'string' || !TOOL_SCOPE_NAME.test(tool)) return false
    try {
      if (authorize) return authorize(peer, tool, action) === true
      return roots ? roots.can(peer, tool, action) === true : false
    } catch { return false }
  }

  const emit = (event) => { if (onCall) { try { onCall(event) } catch { /* the embedder's callback */ } } }
  const handler = webmcpTools({
    window: window ?? {},
    allow,
    ...(tools ? { tools } : {}),
    ...(approve !== undefined ? { approve } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(capture !== undefined ? { capture } : {}),
    limits,
    onCall: emit,
    ...(guard ? { guard } : {}),
    ...(server ? { server } : {}),
    // The bridge never reaches for globals; a window that cannot run timers (a fake one, a tools-only server) gets the realm's own.
    ...(timers ? { timers } : (window?.setTimeout ? {} : { timers: realmTimers() })),
    now,
  })

  /** wsh's hook, for one peer: listing a tool and running one are asked apart, each for its own action. Anything else is refused. */
  const permitsFor = (peer) => (request) => {
    if (request?.kind === 'mcp-tool') return can(peer, request.tool, 'list')
    if (request?.kind === 'mcp-call') return can(peer, request.tool, 'call')
    return false
  }

  /** @type {Set<{ peer: string, since: number, session: object, channel: object }>} */
  const sessions = new Set()
  /** wsh ends a session by itself (`closeSessions`, a failed send); the mesh channel under it is closed here when it does. */
  const reap = () => { for (const s of sessions) if (s.session.closed && !s.channel.closed) { try { s.channel.close('session ended') } catch { /* already closed */ } } }

  const unserve = api.serveProtocol(protocol, (channel) => {
    const peer = channel.peer
    const entry = { peer, since: now(), session: null, channel }
    // The MCP 2026-07-28 surface around wsh's handler (see modern.mjs). It reads `_meta` for the version check only: authorization is the verified peer's, below.
    const modern = createModernLayer({ server, startWatching: () => entry.session.receive({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    const write = async (message) => {
      for (const out of modern.outgoing(message)) {
        await channel.send(labelled(out)).catch((e) => { try { channel.close('send failed') } catch { /* already closed */ } throw e })
      }
    }
    entry.session = serveMcpOverDuplex(modern.wrap(handler), {
      // The channel's own message queue is the duplex: reliable, in order, with the channel's credit as backpressure.
      send: write,
      who: { podId: peer },
      permits: permitsFor(peer),
      maxMessageBytes: Math.min(channel.maxMessageBytes, MAX_MESSAGE_BYTES),
    })
    sessions.add(entry)
    try { onSession?.({ peer, state: 'open' }) } catch { /* the embedder's callback */ }
    channel.onMessage((message) => {
      const answer = modern.incoming(message)
      if (answer) { void channel.send(answer).catch(() => {}); return }
      entry.session.receive(message)
    })
    channel.onClose(() => {
      entry.session.close('channel closed')
      sessions.delete(entry)
      try { onSession?.({ peer, state: 'close' }) } catch { /* the embedder's callback */ }
    })
  })

  return {
    protocol,
    /** Who is connected now. */
    sessions: () => [...sessions].map(({ peer, since }) => ({ peer, since })),
    /** The tools (as `tools/list` states them) that any peer could be granted now. */
    async list() { return (await handler.list()).filter((t) => TOOL_SCOPE_NAME.test(t.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) },
    /** Tell every session (or those of one peer) why, then end it. Resolves with how many were ended. */
    async closeSessions(reason, peer) {
      let fingerprint
      if (peer !== undefined) {
        try { fingerprint = podIdToFingerprint(peer) } catch { return 0 }
      }
      const ended = await handler.closeSessions(reason, fingerprint)
      reap()
      return ended
    },
    /** Stop serving: no new channel opens, and every session ends. */
    async close() {
      unserve()
      await handler.closeSessions('the page stopped serving its tools')
      reap()
    },
  }
}
