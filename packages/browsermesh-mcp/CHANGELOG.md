# @johnhenry/browsermesh-mcp

## 0.2.0

### Minor Changes

- 1363a42: Adopt `@johnhenry/wsh` 0.49.0 (the peer range is now `>=0.49.0 <1.0.0`; tested at 0.49.0).

  - objects: the caller identity handed to wsh's object layer is wsh's own (`normalizeIdentity({ podId })`): a pod id that is not 43 canonical base64url characters is refused instead of passed on. The action table and every decision are unchanged.
  - mcp: the page side is wsh's `serveMcpOverDuplex`, with listing and calling scoped apart through wsh's `permits` hook; the adapter file `rpc-seam.mjs` is removed. The far side now speaks plain MCP JSON-RPC 2.0 in the protocol channel's own messages (this package has not been published before, so nothing older speaks to it). `who` in `prompt` and `onCall` is wsh's identity object: `podId` is the verified peer and `fingerprint` the hex name of the same key (it used to carry the pod id). The `unauthorized` outcome of `onCall` is now reported as `unknown`, which is how the call is answered.

## 0.1.0

### Minor Changes

- 111bd5c: New package: a page's WebMCP tools (or an explicit tool list) served over a browsermesh protocol channel (`serveMcpOnMesh`), and a client and MCP transport for them (`openMcpOnMesh`, `connectMcpOnMesh`, `MeshMcpTransport`). Per-tool `mcp:<tool>:list` and `mcp:<tool>:call` grants through the node's registry (default deny, checked on every request), the approval of consequential tools kept with the serving page, bounds by name, results labelled untrusted, cancel reaching the tool's signal. Peer-depends on `@johnhenry/wsh` (the WebMCP bridge) and `@johnhenry/browsermesh-apps`.
