# browsermesh-objects

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-objects.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-objects)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-objects.svg)](LICENSE)

[wsh](https://github.com/johnhenry/wsh)'s remote-object layer (`@johnhenry/wsh/objects`: values, events,
handles, one-way callbacks) over a BrowserMesh protocol channel. A pod exposes named roots; another pod reaches
them by path (`await remote.app.counter.value`), under two authorisations: wsh's allow-lists (what the host
offers, by path) and the host's `PeerRegistry` grants for the channel's verified peer (what this peer may do,
per root and per action).

Peer dependencies: `@johnhenry/wsh` `>=0.49.0` (tested at 0.49.0 to 0.51.0) and
`@johnhenry/browsermesh-apps` `>=0.21.0` (the protocol channel and `createRootAuthorizer`).
Nothing is served unless `exposeObjectsOnMesh` is called, and nothing is allowed without a grant.

```js
import { attachService, createMeshProtocolService, protocolScope } from '@johnhenry/browsermesh-apps'
import { exposeObjectsOnMesh, openObjectsOnMesh } from '@johnhenry/browsermesh-objects'
import { on, set } from '@johnhenry/wsh/objects'

// host
const host = attachService(node, undefined, createMeshProtocolService())
const objects = exposeObjectsOnMesh(host, {
  roots: { app },
  allow: { get: ['app.title', 'app.counter.**'], call: ['app.counter.inc'], on: ['app.bus@ready'] },
  watch: node.registry.onAccessChange.bind(node.registry), // end a session when a grant is revoked or expires
})
node.registry.grantCapabilities(peerPodId, [protocolScope('objects'), 'objects:app:get', 'objects:app:call'])

// consumer
const { roots, close } = await openObjectsOnMesh(service, hostPodId)
await roots.app.title
await roots.app.counter.inc(1)
await on(roots.app.bus, 'ready', (data) => {})   // refused: the grant has no objects:app:on
```

## API

- `exposeObjectsOnMesh(target, opts)` returns `{ protocol, authorizer, stop(), sessions(), stats() }`.
  `target` is a mesh service (`attachService(node, undefined, createMeshProtocolService())`, or its `.api`) or a
  channel factory `(accept) => stop` for any other protocol host (then `authorizer` is required).
  Options: `roots`, `allow`, `handles`, `eventFields`, `limits` (wsh's, unchanged), `protocol` (default
  `'objects'`: also the prefix of the scopes), `authorizer` (a `createRootAuthorizer`; default: the service's own,
  backed by its registry), `watch` (`registry.onAccessChange.bind(registry)`), `versions`, `maxPendingSends`.
- `openObjectsOnMesh(channel | service, peer, opts)` returns `{ roots, channel, peer, close() }`. With a service
  the channel is opened here (`protocol`, `timeoutMs`); a peer that does not serve it gives an
  `ObjectsOnMeshError` (`reason: 'not-served'`, or `'unsupported'` for a version it cannot speak).
- The helpers that work on references (`get`, `set`, `call`, `on`, `off`, `snapshot`, `describe`, `use`, `release`)
  are wsh's, from `@johnhenry/wsh/objects`.
- `actionFor(op)`, `OBJECT_ACTIONS`, `whoFor(podId)`, `duplexOverChannel(channel)` are exported for hosts that
  build their own plumbing.

## Which grant each operation needs

| Operation | Action | Scope |
| --- | --- | --- |
| read a value, `describe`, `snapshot` | `get` | `objects:ROOT:get` |
| `call`, `construct`, a call that passes callbacks (they are arguments of the call) | `call` | `objects:ROOT:call` |
| `set` | `set` | `objects:ROOT:set` |
| subscribe to an event source | `on` | `objects:ROOT:on` |
| an operation through a handle, including a subscription to an event source reached through one (wsh 0.51) | the action of the operation, on the path that produced the handle | as above |
| `rootDescription` (typed remotes, wsh 0.51) | any action on the root; what is described is narrowed to the actions held | none of the root's actions: refused |
| anything this table does not name | refused | |

Opening the protocol needs `protocol:objects:open`. The scopes use the registry's wildcards (`objects:*:get`,
`objects:app:*`) and expiry. A peer is told of the roots it can use on some action, no others. `on` is not `get`:
a peer granted only `objects:app:get` is refused a subscription.

## Identity

The caller is the channel's verified peer: a pod id, the key the session is bound to, never a field of a message.
It is handed to the layer in `who.podId`; `who.username` and `who.fingerprint` stay `null` (a pod id is not a wsh
key fingerprint, and the layer is never told it is). All decisions are made from `who.podId` (see `src/who.mjs`).

## Revocation and bounds

- A request is judged when it arrives: revoking or expiring a grant refuses the very next one.
- What a peer holds open is judged again: an event subscription needs `on` and a callback needs `call`, at every
  delivery; a peer that has lost one has the session closed and the listener taken out of the host's source. With
  `watch` this happens when the registry announces the change; without it, at the next delivery.
- Losing `protocol:objects:open` closes the channel through the protocol host.
- Events and callbacks leave through the mesh channel's credit. A reader that stops reading makes wsh's bounded
  queue (`maxQueuedEvents`) fill and then drop events, counted: the next event delivered says how many were lost
  before it (`info.dropped`). Responses are bounded too: a peer that keeps asking and never reads is cut off once
  `maxPendingSends` (default 256) writes wait for credit (`stats().closedSlow`).
- A result larger than the channel's `maxMessageBytes` (or wsh's `maxValueBytes`) is refused by name, not sent.
- Handles: wsh's table (`maxHandles`, default 64) is per channel, refused when full, released on
  `release(handle)` and when the session ends.

## Older peers and versions

Nothing new is put on the wire: the layer's messages travel as raw messages of the protocol `objects` (the name
is `protocol`). A peer that has not got the protocol, or has no protocol support at all, answers the open with
-32601; nothing else is sent to it. The layer's own feature list (`events`, `callbacks`, `handles`) is how a client
knows what a host supports, as in wsh.

## Not a sandbox

An allow-list of paths means what it says only because nothing but cloneable values cross. A `call` runs the host
application's function with the caller's arguments, with the application's authority. List the functions you would
hand to that peer; see wsh's README ("Threat model of `values` mode").
