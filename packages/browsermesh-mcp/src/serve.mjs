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
 *   3. this peer may see it (`mcp:<tool>:list`) or call it (`mcp:<tool>:call`), through the registry;
 *   4. for a tool that is not read-only: the person at THIS page says yes (`approve`, `prompt`);
 *   5. bounds, by name (`limits`).
 * The peer is the channel's verified one, never a field of a message. The question to the person is the
 * serving page's: the caller cannot see, answer or influence it.
 */
import { webmcpTools, WEBMCP_DEFAULT_LIMITS } from '@johnhenry/wsh/page'
import { MCP_PROTOCOL, MCP_ACTIONS, TOOL_SCOPE_NAME } from './scopes.mjs'
import { rpcChannelOverMesh, mcpError } from './rpc-seam.mjs'

const realmTimers = () => ({
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id),
})

const INVALID_PARAMS = -32602
const STREAM_LIMIT = -32002

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
  const maxCallsPerMinute = limits.maxCallsPerMinute ?? WEBMCP_DEFAULT_LIMITS.maxCallsPerMinute

  /** @type {Set<{ peer: string, since: number }>} */
  const sessions = new Set()

  const unserve = api.serveProtocol(protocol, (channel) => {
    const peer = channel.peer
    const who = { username: null, fingerprint: peer }
    const session = { peer, since: now(), starts: [] }
    sessions.add(session)
    try { onSession?.({ peer, state: 'open' }) } catch { /* the embedder's callback */ }
    channel.onClose(() => {
      sessions.delete(session)
      try { onSession?.({ peer, state: 'close' }) } catch { /* the embedder's callback */ }
    })

    const rpc = rpcChannelOverMesh(channel, {
      intercept: {
        // Only the tools this peer may list; a tool it may only call is callable but not listed.
        'tools/list': async (_params, _ctx, inner) => {
          const result = await inner()
          return { ...result, tools: (result?.tools ?? []).filter((t) => can(peer, t.name, 'list')) }
        },
        'tools/call': async (params, _ctx, inner) => {
          // Counted whether or not the call is allowed, so a caller cannot probe names without bound.
          const t = now()
          session.starts = session.starts.filter((s) => t - s < 60_000)
          if (session.starts.length >= maxCallsPerMinute) {
            emit({ outcome: 'refused', name: params?.name, who, limit: 'maxCallsPerMinute', detail: `more than ${maxCallsPerMinute} calls in a minute` })
            throw mcpError(STREAM_LIMIT, `refused: maxCallsPerMinute: more than ${maxCallsPerMinute} calls in a minute`, { limit: 'maxCallsPerMinute' })
          }
          session.starts.push(t)
          const name = params?.name
          if (!can(peer, name, 'call')) {
            emit({ outcome: 'unauthorized', name: typeof name === 'string' ? name.slice(0, 128) : undefined, who, detail: 'no grant' })
            // The same answer as a tool that does not exist.
            throw mcpError(INVALID_PARAMS, `unknown tool: ${name}`)
          }
          const result = await inner()
          return {
            ...result,
            // The result is data of this page and may carry text written by third parties; no tool can unset this.
            _meta: { ...(result?._meta ?? {}), 'wsh/untrusted': true, 'browsermesh/untrusted': true },
          }
        },
      },
    })
    handler(rpc, {
      user: null,
      fingerprint: peer,
      // The bridge asks this to decide what a session sees: a tool is visible to a peer with any scope on it.
      permits: (request) => request?.kind === 'mcp-tool' && (can(peer, request.tool, 'list') || can(peer, request.tool, 'call')),
    })
  })

  return {
    protocol,
    /** Who is connected now. */
    sessions: () => [...sessions].map(({ peer, since }) => ({ peer, since })),
    /** The tools (as `tools/list` states them) that any peer could be granted now. */
    async list() { return (await handler.list()).filter((t) => TOOL_SCOPE_NAME.test(t.name)) },
    /** Tell every session (or those of one peer) why, then end it. Resolves with how many were ended. */
    closeSessions: (reason, peer) => handler.closeSessions(reason, peer),
    /** Stop serving: no new channel opens, and every session ends. */
    async close() {
      unserve()
      await handler.closeSessions('the page stopped serving its tools')
    },
  }
}
