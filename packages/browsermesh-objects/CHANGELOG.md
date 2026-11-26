# @johnhenry/browsermesh-objects

## 0.1.5

### Patch Changes

- 4af3c21: The READMEs now say these packages are tested against `@johnhenry/wsh` up to 0.57.0. Nothing in the code of these four changed and every peer range is unchanged: none needs the half-close rule that 0.57 added. The egress package gained tests for a consumer that finishes sending and keeps reading (an answer two seconds later, a large one, a destination that finishes first, both sides finishing, a silent half-closed consumer ended by `idleMs`), and its README says what bounds a half-closed connection; the transport's wsh link ends when it reads the peer's end of stream, and a test now pins that.

## 0.1.4

### Patch Changes

- e26b7e4: The READMEs now say these packages are tested against `@johnhenry/wsh` up to 0.56.1. Nothing in the code changed and every peer range is unchanged: none of these packages uses a wsh forward, so nothing here needs what 0.56 added.

## 0.1.3

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
