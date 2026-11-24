# Protocol channels: the seam for layered protocols

A layered protocol (a remote-object layer, a file protocol, a tool protocol)
should be written once, against a small interface, and run over whatever
carries it. This document defines that interface, says how it is authorised
and discovered on the mesh, and sketches how a remote-object layer
([johnhenry/wsh#190](https://github.com/johnhenry/wsh/issues/190),
`wsh-objects`) would mount on it. Code: `packages/browsermesh-apps/src/protocol-channel.mjs`
(over `mesh-channel.mjs`, #271).

## The interface

```
channel.peer                          verified identity of the other end (a public key)
channel.maxMessageBytes               payload budget for one message
channel.send(obj, { signal })         structured message, Uint8Array included
channel.onMessage(cb)                 cb(obj, { peer }); a returned promise slows the sender
channel.request(method, params, { signal, onProgress, timeoutMs })  -> Promise<result>
channel.notify(method, params)
channel.onRequest(method, handler)    handler(params, { peer, signal, progress })
channel.onNotification(method, handler)  handler(params, { peer })
channel.onClose(cb)
channel.close()
```

`assertProtocolChannel(x)` checks the shape. Beyond the issue's list this adds
`onNotification` (a notify needs a receiver) and `close`. Notes:

- `peer` is the key the session is bound to, never read from a message.
- Bytes are native `Uint8Array` end to end; base64 is a carrier detail inside
  the JSON envelope on the mesh and does not appear here.
- Errors are `MeshChannelError` with JSON-RPC style codes: -32000 unsupported,
  -32001 cancelled/timeout/closed, -32002 too many in flight, -32003
  unauthorized (for handlers to throw), -32004 too large, -32601 unknown method.
- A protocol must register `onRequest` handlers synchronously when it receives
  the channel (serving side), or in `openProtocol`'s `setup(channel)` (opening
  side), so nothing arrives before them.

Three things satisfy it today, and one protocol, `test/helpers/counter-protocol.mjs`
(a remote counter with get / call / subscribe, written against only this
interface), runs unchanged over all three:

1. the mesh: `createMeshProtocolService()` over two peers;
2. a bare in-memory duplex: `createChannelCore` + `createProtocolHost`, no mesh service, no registry;
3. a hand-written in-memory object with no mesh code at all (`memoryChannelPair`).

## Opening by name, authorisation, discovery

```js
// server
const host = attachService(node, undefined, createMeshProtocolService())
host.api.serveProtocol('counter', (channel, { peer, version }) => serveCounter(channel, counter), { versions: [1] })
registry.grantCapabilities(clientKey, ['protocol:counter:open'])

// client
const client = await clientHost.api.openProtocol(serverKey, 'counter', { versions: [1] })
const available = await clientHost.api.listProtocols(serverKey)   // only what this peer may open
```

- Names match `/^[a-z0-9][a-z0-9._-]{0,63}$/`: no `:` and no `*`, so a name can never carry scope syntax.
- Scope: `protocol:<name>:open`, checked with `registry.checkAccess(peer, 'protocol:<name>', 'open')`. **Default deny**: with no grant (or no registry) nothing opens and nothing is listed. The registry's wildcards work: `protocol:*:open`, `protocol:counter:*`.
- Authorisation is checked before existence, so an unauthorised peer learns nothing about what is served (-32003 either way).
- It is re-checked on every request, notification and message of a served channel; revoking the scope closes the channel on its next use (`closeProtocols(peer, name)` closes eagerly).
- Per-protocol finer scopes (per method, per root) are the protocol's business, done in its handlers with `ctx.peer` and the same registry, for example `objects:<root>:get`.
- Versions: the opener offers a list, the server picks the highest common one, else -32000.
- Wire: requests `mesh.protocol.open` / `mesh.protocol.list`, notification `mesh.protocol.close`, protocol methods as `<name>/<method>`, raw messages as `{ $p: name, b }`. A peer without protocol support answers -32601; a peer without the channel refuses at the handshake.

## Mounting a remote-object layer (`wsh-objects`)

Not implemented here. `wsh-objects` is designed in wsh with a transport-neutral core: handles and path addressing, `get`/`call`/`set`, events by subscription, bounded snapshots. Its transport needs map directly onto the interface above:

| `wsh-objects` need | Protocol channel |
|---|---|
| request / response with cancel and progress | `request` with `signal` / `onProgress`; handler `ctx.signal` / `ctx.progress` |
| events by subscription | `notify` from the server, `onNotification` on the client (as the counter's `changed`) |
| bytes in values and snapshots | native `Uint8Array` |
| bounded snapshots | `maxMessageBytes`, plus the link's credit window bounding a slow reader |
| who is calling | `ctx.peer` on every handler |
| close / lease cleanup | `onClose` |

A mount would be: `serveProtocol('objects', channel => objectsServer.attach(channel))`, where `attach` registers `get`/`call`/`set`/`subscribe`/`release` with `channel.onRequest`, checks `objects:<root>:get|call|set` against `registry.checkAccess(ctx.peer, 'objects:<root>', action)` in each handler (the `protocol:objects:open` scope only gates opening the layer), and `openProtocol(peer, 'objects')` yields the client. The CSP-safe design (paths and handles, never evaluated strings) is exactly what this seam carries.

Still missing for that:

- the object layer itself (handles, lifetimes, path resolution, snapshots): wsh#190;
- subscription flow control above the raw notify (a slow subscriber is bounded by credit, but coalescing or dropping events is the layer's policy);
- a way to learn a peer supports the channel without trying (`peerSupports` is a hook; there is no advertisement in discovery yet);
- per-root authorisation helpers (today each handler calls `checkAccess`);
- streams larger than one message (large reads must be chunked by the protocol with `progress`; a stream abstraction over the link is not built);
- a real-WebRTC test of the channel (only in-memory duplexes are tested).

## The remote-eval spike

`spikes/browser-extension-host`'s `exec` evaluates a JavaScript string in a page. That cannot work under a strict Content-Security-Policy and cannot be allow-listed by path. The spike is kept, not deleted; its README and driver now say so at the top and point here. It is private, not a workspace member, and imported by no published package (`browsermesh-pod`, `-apps` and `-meshctl` reference other spikes, not this one), so nothing published reaches that `exec`; there was nothing to gate.
