# MCP across the mesh

A page's WebMCP tools, and any explicit list of tools, reachable from another
browser over a browsermesh protocol channel, with no wsh relay in between.
Item 3 of [#334](https://github.com/johnhenry/browsermesh/issues/334). Code:
`packages/browsermesh-mcp`.

## What it is

A pod that owns tools serves the protocol `mcp` on its protocol host
(`serveMcpOnMesh`). Another pod opens that protocol on a link to it
(`openMcpOnMesh` / `connectMcpOnMesh`) and then lists and calls the tools.
Both sides are plain browsermesh: the link is whatever carries the message
channel (a WebRTC data channel, a relay), the protocol channel is
[`docs/protocol-channel.md`](../protocol-channel.md)'s, and the authorisation is
the node's `PeerRegistry`.

The far side speaks plain MCP JSON-RPC. The methods are the ones MCP names
(`initialize`, `ping`, `tools/list`, `tools/call`, and the notifications
`notifications/initialized`, `notifications/cancelled`,
`notifications/tools/list_changed`, `notifications/message`), so an MCP client
library can be pointed at the channel through a thirty-line transport
(`MeshMcpTransport` is that transport: the SDK's `Client` takes it unchanged).
`openMcpOnMesh` also returns a small typed client for callers that do not want
an MCP library.

### Wire

Nothing new on the link. The protocol name is `mcp` (version `1`); each MCP
request travels as a channel request whose method is the MCP method name
(`mcp/tools/call` on the link, as every protocol method is prefixed with the
protocol name) and whose params are the MCP params; the channel result is the
MCP result. A JSON-RPC error of the tool server becomes a channel error with the
same code, message and data. MCP notifications are channel notifications of the
same name. The MCP request id is the channel's, so a cancel is the channel's
cancel (the caller aborts its request; the serving handler's `signal` fires; see
Cancel).

An older peer: one that has no protocol support answers `mesh.protocol.open`
with -32601; one that has it but does not serve `mcp` answers -32003 (the same
as for a peer that may not open it, so nothing is learned). Nothing is sent to a
peer that did not ask: the serving side only ever answers.

### Two MCP eras on one channel

MCP 2026-07-28 removed `initialize` and sessions: a client probes `server/discover`, and every request carries
`_meta` (protocol version, client info, client capabilities). The channel is already an authenticated, bound session,
so nothing is lost by it. The serving side answers both eras on the same channel and picks per request: a request with
modern `_meta` is served statelessly, `initialize` selects legacy. It is added around wsh's handler in
`packages/browsermesh-mcp/src/modern.mjs` (wsh's handler was already stateless in practice), so it needs no wsh release.

- `server/discover` answers the versions and `tools` capability, with no tool names (what a peer may see is
  `tools/list`, scoped per request), `ttlMs: 0`, `cacheScope: 'private'`.
- An unknown `_meta` version is `UnsupportedProtocolVersionError` (-32022). The mesh's own codes (-32000 to -32003, from
  wsh) are in the part of the server-error range the spec leaves to implementations (-32000 to -32019); the range
  -32020 to -32099 is the spec's, and no mesh-specific meaning uses it.
- `_meta` is read for the version check and for nothing else. `clientInfo` and `clientCapabilities` are self-reported
  by an unauthenticated field of a message; they reach no grant check, no prompt, no `onCall`, and cannot switch on a
  feature (there is none to switch on).
- `tools/list` is sorted by name after the scope filter (the spec's deterministic-order SHOULD).
- List-changed: legacy as before. Modern: `subscriptions/listen` with `toolsListChanged`, acknowledged first, each
  notification tagged with the subscription id; cancelled by `notifications/cancelled`; at most 4 per channel. Only a
  change the peer may list is announced (wsh compares the peer's own filtered list). Watching starts when the stream
  opens; a change before the acknowledgement is held and sent right after it. The typed client waits for the
  acknowledgement before `initialize()` returns, as the legacy handshake is complete when it returns.
- The typed client probes modern first and falls back to legacy; an SDK 2.x client may use either mode (README,
  Compatibility).

## Who is the caller

The channel's verified peer pod id: the key the session is bound to
(`ctx.peer` / `channel.peer`), never a field of a message. It is the only
identity used for authorisation, for the approval prompt ("pod `xyz` asks to
run `buy`") and for the audit event. It is handed to the WebMCP bridge in
the place wsh calls a key's fingerprint, so a prompt shows a pod id where it
would show a fingerprint over wsh.

## Authorisation

Two layers, both default deny.

1. **What the page offers at all.** `allow` (exact tool names) is the page's
   own list, as in wsh's page host: nothing is allowed by default, a tool not on
   it is never listed or callable by anyone.
2. **Which peer may do what to which tool.** Per request, through
   `createRootAuthorizer` over the node's `PeerRegistry` (the protocol name is
   `mcp`, the "root" is the tool name):

   | scope | allows |
   |---|---|
   | `protocol:mcp:open` | opening the channel (and `initialize`, `ping`) |
   | `mcp:<tool>:list` | seeing that tool in `tools/list` |
   | `mcp:<tool>:call` | calling it |
   | `mcp:*:list`, `mcp:*:call` | every tool (the registry's own wildcards) |

   A peer that holds `protocol:mcp:open` and nothing else opens the channel and
   sees an empty list. A tool the peer may not call and a tool that does not exist
   are answered identically (`unknown tool`), and a tool the peer may not list is
   not in its list (a peer with a scope on a tool, either one, hears of changes to
   that tool; a peer with none hears nothing about it).
   Scopes can expire (`grantCapabilities(peer, scopes, { expiresAt })`) and be
   revoked; both are re-checked on **every** request, so a revocation or an
   expiry refuses the very next call. Revoking `protocol:mcp:open` also closes
   the channel at once (the protocol host's own rule).

   Tool names must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` to be
   grantable (they cannot carry scope syntax: no `:` and no `*`). A tool whose
   name does not is never served.

Alignment with wsh: a wsh key's capability `mcp:TOOL` allows a tool, for
listing and calling together. Here the same tool is `mcp:TOOL:list` plus
`mcp:TOOL:call`, which can be granted separately. The strings are different on
purpose (the mesh action is part of the scope, like `objects:ROOT:OP`); the
notation is item 4 of #334. A pod's registry grants are the only source of
permission on the mesh; a wsh key line is not consulted here.

## Approval stays with the page

A tool that is not marked read-only is consequential. Before one runs, the page
that owns the tools asks its own person, with the hook of wsh's page host:
`approve: 'never' | 'consequential' | 'always'`, default `consequential`, and
`prompt(call, who, { signal })` (default: an accessible modal dialog in the
serving window; a serving context with no document and no `prompt` denies what
needs approval). The question is asked in the **serving** page, showing the
caller's pod id, the tool and the input as text. The caller cannot answer it,
pre-answer it, see it, or change what it says: the prompt, its timeout and its
outcome are entirely on the serving side, and the caller sees only "denied".
A cancel from the caller closes the question (the `signal` aborts). Questions
are asked one at a time per session, in order. A grant of `mcp:<tool>:call` is
**not** an approval: it lets a peer ask, the person answers.

## Bounds

All on the serving side, each refused by name and counted in the audit event:

| bound | default | |
|---|---|---|
| `maxTools` | 64 | tools beyond it are not listed and cannot be called |
| `maxSchemaBytes` | 16 KiB | per tool, input plus output schema as JSON; a tool over it is not offered |
| `maxInputBytes` | 64 KiB | arguments of one call |
| `maxResultBytes` | 256 KiB | one result as JSON; larger is refused, not truncated |
| `maxInflight` | 4 | calls running or waiting for the person, per session |
| `maxCallsPerMinute` | 30 | per session; a call to an unknown or unpermitted tool counts |
| `callTimeoutMs` | 120000 | the tool's `signal` aborts and the call fails |

(Defaults are wsh's `WEBMCP_DEFAULT_LIMITS`; `limits` overrides any of them.)
Below them, the message channel's own bounds apply to every protocol: the
message size (a result over it is chunked, within the window), the in-flight
request limit and the credit window.

## Results are untrusted

A tool's result is data of the serving page and may contain text written by
third parties. Every result carries `_meta['wsh/untrusted'] = true` (set by the
bridge) and `_meta['browsermesh/untrusted'] = true` (set by this layer), the
typed client marks it (`result.untrusted === true`), and `initialize` says so in
`instructions`. The text is delivered as text: nothing in this layer parses,
renders or evaluates it. What the caller then does with it (a model reading it as
an instruction) is the caller's, and is the reason a result carries a label.

## Notifications

`notifications/tools/list_changed` is sent when the set of tools a session has
a scope on changes (the page registered or removed a tool, that the page also
allows). The caller refreshes with `tools/list`. A grant
change is not pushed; the next `tools/list` reflects it.

## Cancel

The caller aborts its `callTool(..., { signal })` (or sends
`notifications/cancelled` through the SDK transport, which maps it to the same
abort). The channel sends a cancel; the serving handler's `signal` fires; the
bridge aborts the `signal` it passed to the tool's `execute`, and, if the call
was waiting for the person's answer, closes the question. The caller's
promise rejects as cancelled.

## What is NOT offered

- No sampling, no roots, no elicitation: the server never sends a request to
  the client, the client registers no request handler, so one that arrives is
  answered -32601.
- No resources and no prompts: `initialize` advertises `tools` only.
- No tool the page did not list in `allow`, no tool a peer was not granted.

### Not offered, and why

Beyond tools: resources, prompts, sampling, roots, elicitation, tasks, skills, events and file uploads are not
offered, in either era, and nothing a client declares in its capabilities turns one on. Each would widen what a remote
peer can make a page do (read what the page holds, push text into the page's model, start work that outlives a
request, put bytes into the page) and would need its own scope family next to `mcp:<tool>:list|call` and its own entry
in the threat model of [`docs/security.md`](../security.md#mcp-across-the-mesh) before it could be added. The page's own
approval prompt for a tool that is not read-only already does what elicitation-before-a-destructive-action does, at the
serving page, where the person is. Those methods answer -32601.
- No `tools/call` result streaming beyond what MCP's progress does (not used).

## Where it lives

A new small package, `@johnhenry/browsermesh-mcp`. It peer-depends on
`@johnhenry/wsh` (`/page`: the WebMCP bridge core, its limits and its prompt)
and on `@johnhenry/browsermesh-apps` (the channel and the registry); wsh gains
no dependency on browsermesh.

Why a package of its own rather than inside the objects adapter's package
(`@johnhenry/browsermesh-objects`, item 1, built separately):

- the two have different wsh surfaces (`@johnhenry/wsh/objects` against
  `@johnhenry/wsh/page`) and different release rhythms; a page that wants MCP
  should not install the object layer;
- neither is a dependency of the other: each is the "wsh-on-a-mesh channel"
  for one wsh layer, over the same `ctx.peer` and the same `createRootAuthorizer`,
  and the shared notation (item 4) is a document, not code;
- it keeps the two pull requests apart.

## Seams (what changes when wsh grows)

The bridge core is `webmcpTools(options)`, an rpc handler `(channel, ctx)`. Since
wsh 0.49 it is served over any duplex by `serveMcpOverDuplex(handler, { send, who,
permits })` from `@johnhenry/wsh/page`, which this package calls once per channel
with the protocol channel's own messages as the duplex (reliable, in order, with
the channel's credit as backpressure). The far side speaks plain MCP JSON-RPC 2.0.
The earlier adapter file (`rpc-seam.mjs`, a stand-in for wsh's `RpcChannel` that
wrapped the handlers) is gone: the caller is wsh's identity object
(`{ username: null, fingerprint, podId }`, `podId` the channel's verified peer),
and listing and calling are scoped apart through wsh's `permits` hook
(`{ kind: 'mcp-tool', op: 'list' }` and `{ kind: 'mcp-call', op: 'call' }`). The
one thing this layer still does itself is end the mesh channel when wsh ends the
session (wsh's session has no close callback), and add its own untrusted label.

## Not solved here

- One link, one `mcp` channel per peer (the protocol host's rule): a second
  opener on the same link gets `already-open`.
- The registry's grants decide per tool; there is no per-argument scope.
- A tool does whatever its `execute` does with the serving user's session. Nothing
  here makes that safe: the allow-list, the grants and the prompt narrow who can
  start it and when.
