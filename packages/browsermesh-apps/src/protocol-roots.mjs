/**
 * protocol-roots.mjs -- per-root authorisation for layered protocols.
 *
 * `protocol-channel.mjs` authorises opening a protocol (`protocol:<name>:open`).
 * A protocol that exposes several named roots (a remote-object layer's
 * `docs`, `logs`, `page`, ...) needs a second, finer decision on every request:
 * may THIS peer do THIS action on THIS root. The scope for it is
 *
 *     <protocol>:<root>:<action>        e.g. objects:docs:get   objects:docs:call   objects:docs:set
 *
 * which is `PeerRegistry.checkAccess(peer, '<protocol>:<root>', '<action>')`,
 * so the registry's own wildcards apply (`objects:*:get` every root,
 * `objects:docs:*` every action on one root), grants can expire, and revoking a
 * grant takes effect on the very next request. Default deny: with no `check`
 * nothing is allowed.
 *
 *   const auth = createRootAuthorizer({ protocol: 'objects', actions: ['get', 'call', 'set'],
 *                                       check: (peer, resource, action) => registry.checkAccess(peer, resource, action) })
 *   channel.onRequest('get', auth.guard(({ root, path }, ctx) => read(root, path), { action: 'get', root: p => p.root }))
 *   registry.grantCapabilities(peer, auth.scopes('docs', ['get']))
 *
 * The peer is always the channel's verified one (`ctx.peer`), never a field of
 * a message. Root and action names are restricted to characters that cannot
 * carry scope syntax (no `:` and no `*`), so a name can never widen a scope.
 * A node's protocol service hands out a registry-backed authorizer:
 * `service.api.rootAuthorizer('objects')` (see `createMeshProtocolService`).
 *
 * Scope: this decides requests, which is where a root is named. An open stream
 * or subscription was authorised when it started; a protocol that holds one
 * open for long should call `can()` again where it matters.
 *
 * No browser-only imports.
 */
import { ChannelErrorCode, MeshChannelError } from './mesh-channel.mjs'

const ROOT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ACTION_RE = /^[a-z][a-z0-9._-]{0,31}$/

function validRoot(root) {
  if (typeof root !== 'string' || !ROOT_RE.test(root)) throw new TypeError('root must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ (no ":" and no "*")')
  return root
}
function validAction(action) {
  if (typeof action !== 'string' || !ACTION_RE.test(action)) throw new TypeError('action must match /^[a-z][a-z0-9._-]{0,31}$/ (no ":" and no "*")')
  return action
}
// The same rule as a protocol name in protocol-channel.mjs (kept here so the two modules do not import each other).
const PROTOCOL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
function validProtocol(protocol) {
  if (typeof protocol !== 'string' || !PROTOCOL_RE.test(protocol)) throw new TypeError('protocol name must match /^[a-z0-9][a-z0-9._-]{0,63}$/')
  return protocol
}

/** The scope a peer needs for `action` on `root` of `protocol`: `<protocol>:<root>:<action>`. */
export function rootScope(protocol, root, action) {
  return `${validProtocol(protocol)}:${validRoot(root)}:${validAction(action)}`
}

/**
 * @param {object} opts
 * @param {string} opts.protocol - the protocol's name (as served)
 * @param {(peer: string, resource: string, action: string) => (boolean|{allowed: boolean})} [opts.check]
 *   Usually `registry.checkAccess`. Absent: nothing is allowed. Anything but `true` or `{ allowed: true }`, or a throw, is a denial.
 * @param {string[]} [opts.actions] - the actions the protocol has; the default for `scopes()`
 */
export function createRootAuthorizer({ protocol, check, actions = [] } = {}) {
  validProtocol(protocol)
  if (check !== undefined && typeof check !== 'function') throw new TypeError('createRootAuthorizer: check must be a function')
  const defaultActions = actions.map(validAction)
  const resource = root => `${protocol}:${validRoot(root)}`

  const can = (peer, root, action) => {
    const res = resource(root)
    validAction(action)
    if (!check || typeof peer !== 'string' || !peer) return false
    try {
      const r = check(peer, res, action)
      return r === true || r?.allowed === true
    } catch { return false }
  }
  const denied = () => new MeshChannelError(ChannelErrorCode.UNAUTHORIZED, 'not-authorized', 'not authorised for that')

  const auth = {
    protocol,
    actions: [...defaultActions],
    /** The scope for one root and action. */
    scope: (root, action) => rootScope(protocol, root, action),
    /** The scopes to grant for a root (`registry.grantCapabilities(peer, auth.scopes('docs', ['get']))`). */
    scopes: (root, list = defaultActions) => list.map(action => rootScope(protocol, root, action)),
    can,
    /** @throws {MeshChannelError} -32003 `not-authorized`; the message does not name the root. */
    assert(peer, root, action) {
      if (!can(peer, root, action)) throw denied()
    },
    /** The roots of `roots` the peer may use for `action`. */
    allowed: (peer, roots, action) => roots.filter(root => can(peer, root, action)),
    /**
     * Wrap a request or notification handler: the root is read from the params by `root(params, ctx)`,
     * the peer is `ctx.peer`, and the handler runs only if `can(peer, root, action)`.
     * A missing or malformed root is -32600; no access is -32003.
     */
    guard(handler, { action, root }) {
      if (typeof handler !== 'function') throw new TypeError('guard: handler must be a function')
      validAction(action)
      if (typeof root !== 'function') throw new TypeError('guard: root must be a function (params, ctx) => root name')
      return async (params, ctx) => {
        let name
        try { name = validRoot(root(params, ctx)) } catch {
          throw new MeshChannelError(ChannelErrorCode.INVALID, 'bad-root', 'invalid root')
        }
        if (!can(ctx?.peer, name, action)) throw denied()
        return handler(params, ctx)
      }
    },
  }
  return Object.freeze(auth)
}
