/**
 * client.mjs -- the consuming side: a small typed client over an opened `mcp` protocol channel, and a
 * Transport an MCP client library can be pointed at.
 *
 *   const client = await connectMcpOnMesh(service, bobPodId)       // opens the protocol
 *   await client.initialize()                                       // modern first (server/discover), legacy initialize as the fallback
 *   const tools = await client.listTools()
 *   const result = await client.callTool('search', { q: 'x' }, { signal })   // result.untrusted === true
 *
 *   // or with an MCP SDK client:  await sdkClient.connect(client.transport)
 *
 * The wire is plain MCP JSON-RPC 2.0 in the channel's own messages (what wsh's `serveMcpOverDuplex` speaks), so
 * the transport is a pass-through and the typed client only matches answers to requests by id. The client sends
 * no request the server did not ask for and answers none (a request from the far side gets -32601), so sampling,
 * roots and elicitation are refused. The result of a call is data of the serving page: `untrusted` is always
 * true, and nothing here interprets the text.
 */
import { assertProtocolChannel, MeshChannelError, ChannelErrorCode } from '@johnhenry/browsermesh-apps'
import { MCP_PROTOCOL } from './scopes.mjs'
import { MODERN_PROTOCOL_VERSION, META_VERSION, META_CLIENT_INFO, META_CLIENT_CAPABILITIES, META_SERVER_INFO, UNSUPPORTED_PROTOCOL_VERSION } from './modern.mjs'

/** The legacy revision `initialize` asks for (any of wsh's is answered; this one is what earlier releases spoke). The modern revision is `MODERN_PROTOCOL_VERSION`. */
const LEGACY_PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: '@johnhenry/browsermesh-mcp', version: '0' }
/** A server that answers neither way is not waited for for long: the probe is a question with a known cheap answer. */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000
export const MCP_ERROR_REASON = 'mcp-error'
/** Same as the channel's own default for a request. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Longer than the serving side's call timeout (120 s), so the server's own timeout is the one that answers. */
const DEFAULT_CALL_TIMEOUT_MS = 125_000

const cancelled = (reason, message) => new MeshChannelError(ChannelErrorCode.CANCELLED, reason, message)
/** An MCP/JSON-RPC error object as a channel error: the code, message and data cross unchanged. */
const mcpError = (e) => new MeshChannelError(Number.isInteger(e?.code) ? e.code : ChannelErrorCode.INTERNAL, MCP_ERROR_REASON, String(e?.message ?? 'error'), e?.data)

/**
 * A Transport in the shape the MCP SDK's `Client` takes (structural: the SDK is not imported). The SDK speaks
 * JSON-RPC and so does the channel: messages pass through as they are (a `notifications/cancelled` too, which the
 * serving side turns into an abort of the tool's `signal`).
 */
export class MeshMcpTransport {
  #client
  #started = false
  #closed = false
  #off = []
  sessionId
  onclose
  onerror
  onmessage

  /** @param {object} client what `openMcpOnMesh` returns */
  constructor(client) { this.#client = client }

  async start() {
    if (this.#started) return
    this.#started = true
    this.#off.push(
      this.#client._subscribe('message', (message) => this.onmessage?.(message)),
      this.#client.onClose(() => this.#ended()),
    )
  }

  async send(message) {
    if (this.#closed) throw new Error('the mesh MCP transport is closed')
    if (!message || typeof message !== 'object') throw new TypeError('a JSON-RPC message is an object')
    await this.#client._send(message)
  }

  async close() {
    if (this.#closed) return
    this.#ended()
    await this.#client.close()
  }

  #ended() {
    if (this.#closed) return
    this.#closed = true
    for (const off of this.#off.splice(0)) off()
    this.onclose?.()
  }
}

/**
 * @param {object} channel an opened protocol channel (`service.openProtocol(peer, 'mcp')`)
 * @returns the client: `{ peer, initialize, listTools, callTool, request, notify, onToolsChanged, onLog, onClose, close, transport }`
 */
export function openMcpOnMesh(channel) {
  assertProtocolChannel(channel)
  const hubs = { message: new Set(), changed: new Set(), log: new Set(), close: new Set() }
  const fire = (set, value) => { for (const cb of [...set]) { try { cb(value) } catch { /* a listener's problem */ } } }
  const subscribe = (kind, cb) => { hubs[kind].add(cb); return () => hubs[kind].delete(cb) }
  /** id -> { resolve, reject } of the requests this client made. */
  const pending = new Map()
  let nextId = 1
  let closed = false
  let transport = null
  /** `'unknown'` until `initialize()` has decided; then `'modern'` (2026-07-28: stateless, `_meta` on every request) or `'legacy'`. */
  let era = 'unknown'
  let discovered = null
  let listening = false
  /** Resolves the wait of `initialize()` for the stream's acknowledgement. */
  let acknowledged = null

  const send = (message) => channel.send(message)
  const endPending = (reason, message) => { for (const entry of [...pending.values()]) entry.reject(cancelled(reason, message)) }

  channel.onMessage((message) => {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return
    if (typeof message.method === 'string') {
      // A request of the far side: this client answers none.
      if (Object.hasOwn(message, 'id')) { void send({ jsonrpc: '2.0', id: message.id, error: { code: ChannelErrorCode.METHOD_NOT_FOUND, message: `method not found: ${message.method}` } }).catch(() => {}); return }
      // The only notifications an MCP tool server sends (a tagged one comes from our `subscriptions/listen`). Nothing else is listened for.
      if (message.method === 'notifications/tools/list_changed') fire(hubs.changed)
      else if (message.method === 'notifications/message') fire(hubs.log, message.params)
      else if (message.method === 'notifications/subscriptions/acknowledged') { acknowledged?.(); return }
      else return
      fire(hubs.message, message)
      return
    }
    const entry = pending.get(message.id)
    if (entry) {
      if (Object.hasOwn(message, 'error')) entry.reject(mcpError(message.error))
      else entry.resolve(message.result)
    } else fire(hubs.message, message) // an answer to something the transport sent
  })
  channel.onClose(() => { closed = true; endPending('channel-closed', 'the channel closed'); fire(hubs.close) })

  /** Modern requests carry the version, who asks and what the client offers (nothing: this client answers no request of the server). Ours never override the caller's own `_meta` keys. */
  const withMeta = (params) => {
    const base = params ?? {}
    if (era !== 'modern') return base
    return { ...base, _meta: { [META_VERSION]: MODERN_PROTOCOL_VERSION, [META_CLIENT_INFO]: CLIENT_INFO, [META_CLIENT_CAPABILITIES]: {}, ...(base._meta ?? {}) } }
  }

  // Every request is ended when the channel closes (by either side); the caller's signal cancels just that request.
  const request = (method, params, { signal, timeoutMs = method === 'tools/call' ? DEFAULT_CALL_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS } = {}) => {
    if (closed) return Promise.reject(cancelled('channel-closed', 'the channel closed'))
    if (signal?.aborted) return Promise.reject(cancelled('cancelled', 'request aborted'))
    const id = `c${nextId++}`
    return new Promise((resolve, reject) => {
      let timer
      const done = () => { pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
      const fail = (e, tellFar = false) => {
        if (!pending.has(id)) return
        done()
        reject(e)
        // The far side is told, so the tool's own signal fires.
        if (tellFar && !closed) void send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: withMeta({ requestId: id }) }).catch(() => {})
      }
      const onAbort = () => fail(cancelled('cancelled', 'request aborted'), true)
      pending.set(id, { resolve: (value) => { done(); resolve(value) }, reject: fail })
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => fail(cancelled('timeout', `request ${method} timed out after ${timeoutMs}ms`), true), timeoutMs)
      timer.unref?.()
      send({ jsonrpc: '2.0', id, method, params: withMeta(params) }).catch((e) => fail(e))
    })
  }

  /** The modern change stream: `subscriptions/listen` for the tool list, open until the channel closes. Its answer is the server ending it. */
  async function listen() {
    if (listening || closed) return
    listening = true
    // A long-lived request: no timeout, ended with the channel.
    await request('subscriptions/listen', { notifications: { toolsListChanged: true } }, { timeoutMs: 2 ** 31 - 1 }).catch(() => {})
    listening = false
  }

  const client = {
    peer: channel.peer,
    get closed() { return closed },
    /** Escape hatch for tests and for methods this client has no helper for. */
    request,
    notify: (method, params) => send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }),
    _subscribe: subscribe,
    _send: send,
    /** The era this client settled on (`'unknown'` before `initialize()`; a client that never calls it sends plain requests, which both eras' servers of this package accept). */
    get era() { return era },
    /**
     * Settle the era, modern first. Asks `server/discover` (MCP 2026-07-28); a server that answers it is modern and the
     * result, shaped like an `initialize` result (`protocolVersion`, `capabilities`, `serverInfo`, `instructions`) plus
     * `supportedVersions`, is returned; every request after carries the per-request `_meta`, and tool changes are
     * heard on a `subscriptions/listen` stream. A server that does not (any other error, or no answer in `probeTimeoutMs`)
     * is legacy: `initialize`, then `notifications/initialized` (which is what starts list-changed there). `era` may be
     * `'legacy'` to skip the probe or `'modern'` to refuse the fallback. Calling it again returns the settled answer.
     * @param {{ signal?: AbortSignal, era?: 'auto' | 'modern' | 'legacy', probeTimeoutMs?: number }} [options]
     */
    async initialize({ signal, era: want = 'auto', probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
      if (!['auto', 'modern', 'legacy'].includes(want)) throw new TypeError("era must be 'auto', 'modern' or 'legacy'")
      if (era === 'modern' && discovered) return discovered
      if (want !== 'legacy') {
        try {
          const found = await request('server/discover', { _meta: { [META_VERSION]: MODERN_PROTOCOL_VERSION, [META_CLIENT_INFO]: CLIENT_INFO, [META_CLIENT_CAPABILITIES]: {} } }, { signal, timeoutMs: probeTimeoutMs })
          if (!Array.isArray(found?.supportedVersions) || !found.supportedVersions.includes(MODERN_PROTOCOL_VERSION)) throw mcpError({ code: UNSUPPORTED_PROTOCOL_VERSION, message: 'the peer does not speak MCP 2026-07-28', data: { supported: found?.supportedVersions } })
          era = 'modern'
          discovered = {
            protocolVersion: MODERN_PROTOCOL_VERSION,
            supportedVersions: found.supportedVersions,
            capabilities: found.capabilities ?? {},
            serverInfo: found._meta?.[META_SERVER_INFO] ?? null,
            ...(typeof found.instructions === 'string' ? { instructions: found.instructions } : {}),
          }
          // Subscribed before `initialize()` returns, as the legacy handshake is: a tool registered right after it is heard. A server that never acknowledges is not waited for for long.
          if (found.capabilities?.tools?.listChanged) {
            const ack = new Promise((resolve) => { acknowledged = resolve })
            void listen().catch(() => {})
            await Promise.race([ack, new Promise((resolve) => { const t = setTimeout(resolve, 2000); t.unref?.() })])
          }
          return discovered
        } catch (e) {
          // The caller's own abort, and a closed channel, are not an answer about the peer's era.
          if (signal?.aborted || closed) throw e
          // A modern server that does not speak this version names the ones it does: that is not a legacy server, and this client has no other modern version.
          if (want === 'modern' || e?.code === UNSUPPORTED_PROTOCOL_VERSION) throw e
        }
      }
      era = 'legacy'
      const result = await request('initialize', { protocolVersion: LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, { signal })
      await client.notify('notifications/initialized')
      return result
    },
    /** The tools this peer may list. */
    async listTools({ signal } = {}) {
      const result = await request('tools/list', {}, { signal })
      return Array.isArray(result?.tools) ? result.tools : []
    },
    /** Call a tool. `signal` cancels: the serving page's tool sees its own `signal` abort. The result is always marked `untrusted`. */
    async callTool(name, args = {}, { signal, timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
      const result = await request('tools/call', { name, arguments: args }, { signal, timeoutMs })
      return { ...result, untrusted: true }
    },
    onToolsChanged: (cb) => subscribe('changed', cb),
    onLog: (cb) => subscribe('log', cb),
    onClose(cb) {
      if (closed) { queueMicrotask(cb); return () => {} }
      return subscribe('close', cb)
    },
    close() { endPending('channel-closed', 'the channel closed'); channel.close() },
    /** An MCP SDK `Transport` over this channel. */
    get transport() { return (transport ??= new MeshMcpTransport(client)) },
  }
  return client
}

/**
 * Open the `mcp` protocol on `peer` and return the client.
 * @param {object} service the api of `attachService(node, undefined, createMeshProtocolService())`
 * @param {string} peer pod id of the pod that serves the tools
 * @param {{ protocol?: string, signal?: AbortSignal, timeoutMs?: number }} [options]
 */
export async function connectMcpOnMesh(service, peer, { protocol = MCP_PROTOCOL, signal, timeoutMs } = {}) {
  const api = service?.api && typeof service.api.openProtocol === 'function' ? service.api : service
  if (!api || typeof api.openProtocol !== 'function') throw new TypeError('connectMcpOnMesh: first argument must be a protocol service')
  return openMcpOnMesh(await api.openProtocol(peer, protocol, { signal, timeoutMs }))
}
