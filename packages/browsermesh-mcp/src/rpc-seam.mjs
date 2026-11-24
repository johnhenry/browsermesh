/**
 * rpc-seam.mjs -- the one file that knows the shape of wsh's WebMCP bridge.
 *
 * In wsh 0.48 the bridge core is `webmcpTools(options)`: a handler `(channel, ctx)` that wants the part of
 * wsh's own `RpcChannel` it uses (`onRequest`, `onNotification`, `notify`, `close`, an assignable `onClose`)
 * and a caller identity in `ctx`. A browsermesh protocol channel is a different object with the same
 * jobs, so this gives the bridge a small stand-in backed by the protocol channel:
 *
 *   - handlers run on the protocol channel, with the channel's own `ctx` (`id`, `signal`, `peer`);
 *   - a hook per method may wrap a handler (the per-tool grants are applied there, by the caller);
 *   - errors keep their JSON-RPC code, message and data (`RpcError` -> `MeshChannelError`),
 *     so the caller sees what an MCP client would see.
 *
 * When wsh exports the handler core for any duplex with a transport-neutral caller identity, this is the
 * file that is replaced.
 */
import { MeshChannelError } from '@johnhenry/browsermesh-apps'

export const MCP_ERROR_REASON = 'mcp-error'

/** An MCP/JSON-RPC error as a channel error: the code, message and data cross unchanged. */
export function mcpError(code, message, data) {
  return new MeshChannelError(code, MCP_ERROR_REASON, message, data)
}

/** @param {unknown} e */
export function asChannelError(e) {
  if (e instanceof MeshChannelError) return e
  if (Number.isInteger(e?.code)) return mcpError(e.code, e.message, e.data)
  return e
}

/**
 * @param {object} channel a protocol channel (see `assertProtocolChannel`)
 * @param {{ intercept?: Record<string, (params: any, ctx: any, inner: () => Promise<any>) => Promise<any>> }} [options]
 *   `intercept[method]` runs instead of the handler the bridge registers for `method`, and calls `inner()` to reach it.
 */
export function rpcChannelOverMesh(channel, { intercept = {} } = {}) {
  let onClose = null
  channel.onClose((error) => {
    try { onClose?.(error?.message ?? 'closed') } catch { /* the bridge's cleanup must not break the close */ }
  })
  return {
    get closed() { return channel.closed === true },
    onRequest(method, handler) {
      const hook = intercept[method]
      return channel.onRequest(method, async (params, ctx) => {
        try {
          return hook ? await hook(params, ctx, () => handler(params, ctx)) : await handler(params, ctx)
        } catch (e) {
          throw asChannelError(e)
        }
      })
    },
    onNotification(method, handler) {
      return channel.onNotification(method, (params) => handler(params))
    },
    notify(method, params) { return channel.notify(method, params) },
    async close(reason) { channel.close(reason) },
    get onClose() { return onClose },
    set onClose(fn) { onClose = typeof fn === 'function' ? fn : null },
  }
}
