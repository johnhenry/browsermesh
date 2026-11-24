---
'@johnhenry/browsermesh-objects': minor
---

A new package: wsh's remote-object layer (`@johnhenry/wsh/objects`: values, events, handles, one-way callbacks) over a mesh protocol channel (#334).

`exposeObjectsOnMesh(service | channelFactory, { roots, allow, handles?, eventFields?, limits?, protocol = 'objects', authorizer?, watch? })` serves the layer to peers; `openObjectsOnMesh(channel | service, peer, opts)` consumes it and returns the host's roots as lazy references.

- The caller is the channel's verified peer (a pod id), handed to the layer in a neutral `who.podId` slot and never as a fake fingerprint.
- Every operation is judged by its own action through `createRootAuthorizer`: get, describe and snapshot need `objects:ROOT:get`; call, construct and the callbacks passed to a call need `call`; set needs `set`; a subscription needs `on`. An operation the table does not name is refused. wsh's allow-lists apply first, then the registry grant; both must say yes.
- A revoked or expired grant refuses the next request, and ends an open subscription or callback it allowed (at once with the `watch` option, otherwise at the next delivery).
- Events and callbacks leave through the channel's credit, so a reader that stops reading makes the layer's bounded queue drop and count events; a peer that keeps asking without reading is cut off.

Additive: nothing is served unless `exposeObjectsOnMesh` is called. A peer that does not serve the protocol answers the open with an error that `openObjectsOnMesh` reports as `ObjectsOnMeshError` (`reason: 'not-served'`); nothing else is sent to it. Peer dependencies: `@johnhenry/wsh` >= 0.48.0 and `@johnhenry/browsermesh-apps` >= 0.21.0.
