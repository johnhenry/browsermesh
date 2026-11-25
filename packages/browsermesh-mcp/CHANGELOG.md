# @johnhenry/browsermesh-mcp

## 0.2.2

### Patch Changes

- fd64dd0: Adopt wsh 0.54.0. wsh now closes a host connection that has not completed its login 60 seconds after the host accepted
  it. The wsh link (`WshPeerLinks`) and `WshServices` accept a host half at a pipe relay when it connects, long before a peer
  pairs with it, so with that default every idle half would have been closed and re-opened each minute; their hosts for
  those halves are now created with `loginTimeoutMs: 0` (no deadline between connecting to the relay and the peer's first
  message, which is what they had before). A mesh protocol channel keeps wsh's default, since its peer logs in as soon as it
  opens it. Nothing new is sent on the wire and an older wsh ignores the option. `browsermesh-mcp` and `browsermesh-objects`
  are tested against wsh 0.54.0 (documentation only).
- 3f46714: Use wsh 0.54.1's `accept(socket, { waitForPeer })` for the host halves that wait at a pipe relay. `WshPeerLinks` and
  `WshServices` accept a waiting half when it reaches the relay, long before a peer pairs with it. They no longer switch the
  login deadline off for those hosts: each half is accepted with `waitForPeer`, so wsh's 60 second login deadline starts when
  the peer arrives (the relay's paired signal, requested by dialling the half with `?paired=1`, or the peer's first byte when
  that comes first or the relay predates the signal). A half that waits is neither refused nor closed however long it waits,
  and a peer that pairs and then does not log in is closed at the deadline. A relay that predates the signal ignores
  `?paired=1`; the first byte then starts the clock, and a peer that arrives and sends nothing is not bounded by the login
  deadline there. With an older wsh (`@johnhenry/wsh/pipe-relay` has no `watchPairing`) the hosts for those halves keep
  `loginTimeoutMs: 0`, as before; the optional peer range stays `*`. Nothing new is required of the peer. The in-process test
  relay (`@johnhenry/browsermesh-transport/wsh-in-process`) passes the paired signal on. `browsermesh-mcp` and
  `browsermesh-objects` are tested against wsh 0.54.1 (documentation only).

## 0.2.1

### Patch Changes

- bfc4133: Follow wsh 0.52.0's numbering of the gateway failure codes. In netway's `GATEWAY_ERROR`, `TIMEOUT` is now `8` and
  `GATEWAY_DISABLED: 5` is new (the rest are unchanged: 1 to 4, `CLOSED` 6, `QUEUE_FULL` 7). `GatewayBackend` throws a
  received 8 as an `OperationTimeoutError`, like its own operation timeout. A received 5 is read as "the gateway is
  disabled, or a timeout from an older gateway" and its `ConnectionRefusedError` says so, because the Rust server has
  always sent 5 for a disabled gateway and a Node gateway at wsh 0.51.0 or earlier sent 5 for a timeout. netway itself
  sends no failure code. Compatibility: a netway peer on the previous version reads an 8 from a gateway as a code it does
  not know (it throws a `ConnectionRefusedError` with the host's message and `(code: 8)`, no more), and a peer on the
  previous version, and a gateway at 0.51.0 or earlier, still use 5 for a timeout, which the new version reads as
  described above (netway has no code of its own to send, so the only senders are gateways).
  `browsermesh-mcp`, `browsermesh-objects` and `browsermesh-transport` are tested against wsh 0.52.0 (documentation only).

## 0.2.0

### Minor Changes

- 1363a42: Adopt `@johnhenry/wsh` 0.49.0 (the peer range is now `>=0.49.0 <1.0.0`; tested at 0.49.0).

  - objects: the caller identity handed to wsh's object layer is wsh's own (`normalizeIdentity({ podId })`): a pod id that is not 43 canonical base64url characters is refused instead of passed on. The action table and every decision are unchanged.
  - mcp: the page side is wsh's `serveMcpOverDuplex`, with listing and calling scoped apart through wsh's `permits` hook; the adapter file `rpc-seam.mjs` is removed. The far side now speaks plain MCP JSON-RPC 2.0 in the protocol channel's own messages (this package has not been published before, so nothing older speaks to it). `who` in `prompt` and `onCall` is wsh's identity object: `podId` is the verified peer and `fingerprint` the hex name of the same key (it used to carry the pod id). The `unauthorized` outcome of `onCall` is now reported as `unknown`, which is how the call is answered.

## 0.1.0

### Minor Changes

- 111bd5c: New package: a page's WebMCP tools (or an explicit tool list) served over a browsermesh protocol channel (`serveMcpOnMesh`), and a client and MCP transport for them (`openMcpOnMesh`, `connectMcpOnMesh`, `MeshMcpTransport`). Per-tool `mcp:<tool>:list` and `mcp:<tool>:call` grants through the node's registry (default deny, checked on every request), the approval of consequential tools kept with the serving page, bounds by name, results labelled untrusted, cancel reaching the tool's signal. Peer-depends on `@johnhenry/wsh` (the WebMCP bridge) and `@johnhenry/browsermesh-apps`.
