# @johnhenry/browsermesh-objects

## 0.1.2

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
- 99cb1c8: Run on `@johnhenry/wsh` 0.51 (tested range 0.49.0 to 0.51.0; the peer range is unchanged). An event subscription made
  through a handle is judged for the root of the handle's path, needs `objects:ROOT:on` at every delivery, and ends the
  session when that grant is revoked or expires (before, such events were not delivered). The registry is now also asked
  the layer's own question (`permit`) before a root is read or described, so a root the peer holds no action on is not
  described, and what is described is narrowed to the actions it holds. Nothing new on the wire; an older peer is
  unaffected.

## 0.1.1

### Patch Changes

- 1363a42: Adopt `@johnhenry/wsh` 0.49.0 (the peer range is now `>=0.49.0 <1.0.0`; tested at 0.49.0).

  - objects: the caller identity handed to wsh's object layer is wsh's own (`normalizeIdentity({ podId })`): a pod id that is not 43 canonical base64url characters is refused instead of passed on. The action table and every decision are unchanged.
  - mcp: the page side is wsh's `serveMcpOverDuplex`, with listing and calling scoped apart through wsh's `permits` hook; the adapter file `rpc-seam.mjs` is removed. The far side now speaks plain MCP JSON-RPC 2.0 in the protocol channel's own messages (this package has not been published before, so nothing older speaks to it). `who` in `prompt` and `onCall` is wsh's identity object: `podId` is the verified peer and `fingerprint` the hex name of the same key (it used to carry the pod id). The `unauthorized` outcome of `onCall` is now reported as `unknown`, which is how the call is answered.

## 0.1.0

### Minor Changes

- 356b3ab: A new package: wsh's remote-object layer (`@johnhenry/wsh/objects`: values, events, handles, one-way callbacks) over a mesh protocol channel (#334).

  `exposeObjectsOnMesh(service | channelFactory, { roots, allow, handles?, eventFields?, limits?, protocol = 'objects', authorizer?, watch? })` serves the layer to peers; `openObjectsOnMesh(channel | service, peer, opts)` consumes it and returns the host's roots as lazy references.

  - The caller is the channel's verified peer (a pod id), handed to the layer in a neutral `who.podId` slot and never as a fake fingerprint.
  - Every operation is judged by its own action through `createRootAuthorizer`: get, describe and snapshot need `objects:ROOT:get`; call, construct and the callbacks passed to a call need `call`; set needs `set`; a subscription needs `on`. An operation the table does not name is refused. wsh's allow-lists apply first, then the registry grant; both must say yes.
  - A revoked or expired grant refuses the next request, and ends an open subscription or callback it allowed (at once with the `watch` option, otherwise at the next delivery).
  - Events and callbacks leave through the channel's credit, so a reader that stops reading makes the layer's bounded queue drop and count events; a peer that keeps asking without reading is cut off.

  Additive: nothing is served unless `exposeObjectsOnMesh` is called. A peer that does not serve the protocol answers the open with an error that `openObjectsOnMesh` reports as `ObjectsOnMeshError` (`reason: 'not-served'`); nothing else is sent to it. Peer dependencies: `@johnhenry/wsh` >= 0.48.0 and `@johnhenry/browsermesh-apps` >= 0.21.0.
