# @johnhenry/browsermesh-objects

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
