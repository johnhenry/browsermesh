# browsermesh-mcp

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-mcp.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-mcp)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-mcp.svg)](LICENSE)

A page's WebMCP tools (or any explicit list of tools) reachable from **another
browser** over a browsermesh protocol channel, with no wsh relay in between.

The far side speaks plain MCP JSON-RPC, so an MCP client library can be pointed
at the channel through a tiny transport; a small typed client is included. The
tool bridge is wsh's (`@johnhenry/wsh/page`), peer-depended on; wsh has no
dependency on browsermesh. Design and rules:
[`docs/design/mcp-over-mesh.md`](../../docs/design/mcp-over-mesh.md); threat
model: [`docs/security.md`](../../docs/security.md#mcp-across-the-mesh).

```js
import { attachService, createMeshProtocolService } from '@johnhenry/browsermesh-apps'
import { captureWebMcp } from '@johnhenry/wsh/page'
import { serveMcpOnMesh, connectMcpOnMesh, mcpScopes } from '@johnhenry/browsermesh-mcp'

// --- the page that owns the tools (call captureWebMcp BEFORE the application's code) ---
captureWebMcp(window)
const service = attachService(node, undefined, createMeshProtocolService()).api
const served = serveMcpOnMesh(service, {
  window,
  allow: ['search', 'checkout'],       // what the page offers at all; nothing by default
  approve: 'consequential',            // default: the PERSON AT THIS PAGE is asked before a tool that is not read-only runs
})
node.registry.grantCapabilities(peerPodId, [...mcpScopes.open(), ...mcpScopes.tool('search')])

// --- another browser ---
const client = await connectMcpOnMesh(callerService, serverPodId)
await client.initialize()
const tools = await client.listTools()                       // only what this peer may list
const result = await client.callTool('search', { q: 'x' }, { signal })   // result.untrusted === true
// or with an MCP SDK client:  await sdkClient.connect(client.transport)
```

## Who may do what

Default deny at every step; asked of the node's `PeerRegistry` for the channel's
verified peer on every request, so a revocation or an expiry applies to the next
call.

| scope | allows |
|---|---|
| `protocol:mcp:open` | opening the channel (`mcpScopes.open()`) |
| `mcp:<tool>:list` | seeing the tool in `tools/list` |
| `mcp:<tool>:call` | calling it (`mcpScopes.tool(name)` gives both) |
| `mcp:*:list`, `mcp:*:call` | every tool (`mcpScopes.all()`) |

A grant lets a peer *ask*. A tool that is not read-only is then asked about by the
**serving** page (`approve`, `prompt`); the caller never sees or answers that.

## What is and is not offered

Tools only. No resources, prompts, sampling, roots or elicitation. Results are
labelled untrusted (`_meta['wsh/untrusted']` from wsh and `_meta['browsermesh/untrusted']` from this layer,
`untrusted: true` on the typed client). The caller is wsh's identity object in the prompt and in `onCall`:
`{ username: null, fingerprint, podId }`, `podId` the channel's verified peer and `fingerprint` the hex name of the same key. Bounds (`limits`) are wsh's `WEBMCP_DEFAULT_LIMITS`: 64 tools,
16 KiB of schema per tool, 64 KiB of input, 256 KiB of result, 4 in flight and 30
calls a minute per session, a 120 s call timeout. Cancelling a call, or closing
the channel, aborts the tool's `signal`.

## API

- `serveMcpOnMesh(service, { window | tools, allow, approve, prompt, capture, limits, authorize, onCall, onSession })`
  returns `{ sessions(), list(), closeSessions(reason, peer?), close() }`. `authorize(peer, tool, action)` replaces
  the registry-backed decision.
- `openMcpOnMesh(channel)` / `connectMcpOnMesh(service, peer)`: `{ initialize, listTools, callTool, request,
  onToolsChanged, onLog, onClose, close, transport }`.
- `MeshMcpTransport`: an MCP SDK `Transport` over the channel (cancel notifications abort the request).
- `mcpScopes`, `MCP_PROTOCOL`.

## Compatibility

Nothing new on the link: the protocol name is `mcp` (version 1) on the existing protocol seam, and its messages are
plain MCP JSON-RPC 2.0 objects in the channel's own messages (wsh's `serveMcpOverDuplex`). A peer without
protocol support answers `mesh.protocol.open` with -32601; one that does not serve `mcp` answers -32003. Peer
dependencies: `@johnhenry/wsh` >=0.49.0 (tested at 0.49.0 to 0.51.0) and `@johnhenry/browsermesh-apps`. This package has
not been published before this change; nothing older speaks to it.
