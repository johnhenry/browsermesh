/**
 * client.mjs -- the consuming side: a small typed client over an opened `mcp` protocol channel, and a
 * Transport an MCP client library can be pointed at.
 *
 *   const client = await connectMcpOnMesh(service, bobPodId)       // opens the protocol
 *   await client.initialize()
 *   const tools = await client.listTools()
 *   const result = await client.callTool('search', { q: 'x' }, { signal })   // result.untrusted === true
 *
 *   // or with an MCP SDK client:  await sdkClient.connect(client.transport)
 *
 * The client sends no request the server did not ask for and answers none: it registers no request handler,
 * so sampling, roots and elicitation requests from the far side are refused (-32601). The result of a call is
 * data of the serving page: `untrusted` is always true, and nothing here interprets the text.
 */
import { assertProtocolChannel } from '@johnhenry/browsermesh-apps'
import { MCP_PROTOCOL } from './scopes.mjs'

const PROTOCOL_VERSION = '2025-06-18'
/** Longer than the serving side's call timeout (120 s), so the server's own timeout is the one that answers. */
const DEFAULT_CALL_TIMEOUT_MS = 125_000

const isCancel = (e) => e?.code === -32001

/** An MCP JSON-RPC error object from a thrown channel error. */
function rpcErrorOf(e) {
  return { code: Number.isInteger(e?.code) ? e.code : -32603, message: String(e?.message ?? e), ...(e?.data !== undefined ? { data: e.data } : {}) }
}

/**
 * A Transport in the shape the MCP SDK's `Client` takes (structural: the SDK is not imported).
 * JSON-RPC requests become channel requests, notifications become channel notifications, and
 * `notifications/cancelled` aborts the request it names (the channel then cancels it on the far side).
 */
export class MeshMcpTransport {
  #client
  #inflight = new Map()
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
      this.#client._subscribe('notification', (message) => this.onmessage?.(message)),
      this.#client.onClose(() => this.#ended()),
    )
  }

  async send(message) {
    if (this.#closed) throw new Error('the mesh MCP transport is closed')
    if (!message || typeof message !== 'object') throw new TypeError('a JSON-RPC message is an object')
    const { method, id, params } = message
    if (typeof method !== 'string') return // a response to a server request: there are none to answer
    if (id === undefined) {
      if (method === 'notifications/cancelled') { this.#inflight.get(params?.requestId)?.abort(); return }
      await this.#client.notify(method, params)
      return
    }
    const controller = new AbortController()
    this.#inflight.set(id, controller)
    this.#client.request(method, params, { signal: controller.signal, timeoutMs: method === 'tools/call' ? DEFAULT_CALL_TIMEOUT_MS : undefined }).then(
      (result) => { if (!controller.signal.aborted) this.onmessage?.({ jsonrpc: '2.0', id, result }) },
      (e) => { if (!(controller.signal.aborted && isCancel(e))) this.onmessage?.({ jsonrpc: '2.0', id, error: rpcErrorOf(e) }) },
    ).finally(() => this.#inflight.delete(id))
  }

  async close() {
    if (this.#closed) return
    this.#ended()
    await this.#client.close()
  }

  #ended() {
    if (this.#closed) return
    this.#closed = true
    for (const controller of this.#inflight.values()) controller.abort()
    this.#inflight.clear()
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
  const hubs = { notification: new Set(), changed: new Set(), log: new Set(), close: new Set() }
  const fire = (set, value) => { for (const cb of [...set]) { try { cb(value) } catch { /* a listener's problem */ } } }
  const subscribe = (kind, cb) => { hubs[kind].add(cb); return () => hubs[kind].delete(cb) }
  let closed = false
  let transport = null

  // The only notifications an MCP tool server sends. Nothing else is listened for.
  channel.onNotification('notifications/tools/list_changed', (params) => {
    fire(hubs.changed)
    fire(hubs.notification, { jsonrpc: '2.0', method: 'notifications/tools/list_changed', ...(params !== undefined ? { params } : {}) })
  })
  channel.onNotification('notifications/message', (params) => {
    fire(hubs.log, params)
    fire(hubs.notification, { jsonrpc: '2.0', method: 'notifications/message', ...(params !== undefined ? { params } : {}) })
  })
  const pending = new Set()
  const abortPending = () => { for (const c of [...pending]) c.abort() }
  channel.onClose(() => { closed = true; abortPending(); fire(hubs.close) })

  // Every request is ended when the channel closes (by either side); the caller's signal cancels just that request.
  const request = (method, params, { signal, timeoutMs } = {}) => {
    const own = new AbortController()
    const onAbort = () => own.abort()
    if (signal?.aborted) own.abort(); else signal?.addEventListener('abort', onAbort, { once: true })
    pending.add(own)
    return channel.request(method, params ?? {}, { signal: own.signal, ...(timeoutMs ? { timeoutMs } : {}) })
      .finally(() => { pending.delete(own); signal?.removeEventListener('abort', onAbort) })
  }

  const client = {
    peer: channel.peer,
    get closed() { return closed },
    /** Escape hatch for tests and for methods this client has no helper for. */
    request,
    notify: (method, params) => channel.notify(method, params),
    _subscribe: subscribe,
    /** `initialize`, then `notifications/initialized` (which is what starts list-changed). */
    async initialize({ signal } = {}) {
      const result = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: '@johnhenry/browsermesh-mcp', version: '0' } }, { signal })
      await channel.notify('notifications/initialized')
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
    close() { abortPending(); channel.close() },
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
