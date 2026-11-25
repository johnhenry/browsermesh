# @johnhenry/browsermesh-mcp

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
