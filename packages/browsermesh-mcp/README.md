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
// or with an MCP SDK client:  await sdkClient.connect(client.transport)   (see Compatibility for the 2.x options)
```

## Install

```bash
npm install @johnhenry/browsermesh-mcp @johnhenry/browsermesh-apps @johnhenry/wsh
```

Needs Node 26 or later. `@johnhenry/wsh` and `@johnhenry/browsermesh-apps` are peer dependencies (see Compatibility below).

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
- `openMcpOnMesh(channel)` / `connectMcpOnMesh(service, peer)`: `{ initialize, era, listTools, callTool, request,
  onToolsChanged, onLog, onClose, close, transport }`. `initialize({ era })` settles the protocol era (below);
  `era` is `'unknown'` until it has.
- `MeshMcpTransport`: an MCP SDK `Transport` over the channel (cancel notifications abort the request).
- `mcpScopes`, `MCP_PROTOCOL`.

## Compatibility

Nothing new on the link: the protocol name is `mcp` (version 1) on the existing protocol seam, and its messages are
plain MCP JSON-RPC 2.0 objects in the channel's own messages (wsh's `serveMcpOverDuplex`). A peer without
protocol support answers `mesh.protocol.open` with -32601; one that does not serve `mcp` answers -32003. Peer
dependencies: `@johnhenry/wsh` >=0.49.0 (tested at 0.49.0 to 0.62.1) and `@johnhenry/browsermesh-apps`.

**MCP revisions.** The serving side speaks both eras on one channel, with any of those wsh releases (the 2026-07-28
surface is added in this package, around wsh's handler, so no wsh release is needed):

- **2026-07-28 (modern):** no `initialize`, no session. `server/discover` answers the supported versions
  (`2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`) and the capabilities (`tools` only; no tool
  names, so a peer that may only open the channel learns nothing about what is served). Requests carry
  `_meta` (`io.modelcontextprotocol/protocolVersion`, `.../clientInfo`, `.../clientCapabilities`); a version this side
  does not speak is answered with `UnsupportedProtocolVersionError` (-32022, `data.supported`). Results carry
  `resultType: 'complete'`, and `tools/list` `ttlMs: 0` and `cacheScope: 'private'` (the list is per peer). List-changed
  is heard on a `subscriptions/listen` stream (`toolsListChanged` only; at most 4 streams per channel). `ping` is not
  part of this era; it is still answered for legacy callers.
- **2025-11-25 and earlier (legacy):** `initialize` and `notifications/initialized`, answered as before, and list-changed
  as a plain notification once `notifications/initialized` has been sent.
- Nothing a peer puts in `_meta` (client info, declared capabilities) is read for authorization: the caller is the
  channel's verified peer, and what it may see and do is the registry's grants, as before. Tools only, in both eras.
- `tools/list` is always in name order, after the per-peer scope filter.
- The one deviation: `closeSessions(reason)` tells a *legacy* caller why with a `notifications/message`; a peer that
  only ever spoke modern is not sent it (the spec forbids log messages to a client that set no log level) and sees the
  channel close.

**The typed client** (`connectMcpOnMesh` / `openMcpOnMesh`): `initialize()` asks `server/discover` first (modern); a peer
that answers it is modern, and requests carry `_meta` from then on; any other answer (or none within `probeTimeoutMs`,
10 s) means legacy, and it does `initialize` + `notifications/initialized` as before. `initialize({ era: 'legacy' })`
skips the probe, `{ era: 'modern' }` refuses the fallback. On a modern peer the result has the shape of an
`initialize` result (`protocolVersion`, `capabilities`, `serverInfo`, `instructions`) plus `supportedVersions`.
A client that never calls `initialize()` sends plain requests, which both eras' servers of this package accept.
Against a peer on an older release of this package (legacy only) it falls back to legacy at the cost of one
refused request.

**An MCP SDK client** (`@modelcontextprotocol/client` 2.x) through `client.transport`: its default
`versionNegotiation.mode` is `'legacy'` (plain `initialize`), which works with every release of this package. For the
modern era pass `{ versionNegotiation: { mode: 'auto' } }` (probes `server/discover`, falls back to legacy on a legacy-only
peer) or `{ mode: { pin: '2026-07-28' } }` (modern only; fails on a peer that is not). Tested at 2.4.0 against both.

## License

MIT
