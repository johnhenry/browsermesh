/**
 * scopes.mjs -- the grant strings of MCP over the mesh.
 *
 *   protocol:mcp:open     open the channel (and initialize, ping)
 *   mcp:<tool>:list       see that tool in tools/list
 *   mcp:<tool>:call       call it
 *   mcp:*:list, mcp:*:call   every tool (the registry's own wildcards)
 *
 * They are checked per request through `PeerRegistry.checkAccess(peer, 'mcp:<tool>', action)`
 * (see `createRootAuthorizer` in browsermesh-apps), so a revocation or an expiry applies to the
 * very next request. A tool name must be able to sit in a scope: letters, digits, `.`, `_` and
 * `-`, no `:` and no `*`, so a name can never widen a grant.
 */

export const MCP_PROTOCOL = 'mcp'

/** The tool names that can be granted. Wider than wsh's tool names only in that a name may not start with `_`, `.` or `-`. */
export const TOOL_SCOPE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export const MCP_ACTIONS = Object.freeze(['list', 'call'])

/** @param {string} name @returns {string} */
function toolName(name) {
  if (typeof name !== 'string' || !TOOL_SCOPE_NAME.test(name)) throw new TypeError('tool name must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ (no ":" and no "*")')
  return name
}

/** The scopes to hand to `registry.grantCapabilities(peer, ...)`. */
export const mcpScopes = Object.freeze({
  /** `['protocol:mcp:open']` */
  open: (protocol = MCP_PROTOCOL) => [`protocol:${protocol}:open`],
  /** `mcp:<tool>:<action>` for each action (default: list and call). */
  tool: (name, actions = MCP_ACTIONS, protocol = MCP_PROTOCOL) => actions.map((action) => {
    if (!MCP_ACTIONS.includes(action)) throw new TypeError(`unknown action ${JSON.stringify(action)} (list, call)`)
    return `${protocol}:${toolName(name)}:${action}`
  }),
  /** Every tool: `mcp:*:list` and `mcp:*:call`. */
  all: (actions = MCP_ACTIONS, protocol = MCP_PROTOCOL) => actions.map((action) => `${protocol}:*:${action}`),
})
