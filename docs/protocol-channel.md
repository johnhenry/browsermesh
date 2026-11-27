# Protocol channels: the seam for layered protocols

A layered protocol (a remote-object layer, a file protocol, a tool protocol)
should be written once, against a small interface, and run over whatever
carries it. This document defines that interface, says how it is authorised
and discovered on the mesh, and says how a remote-object layer
([johnhenry/wsh#190](https://github.com/johnhenry/wsh/issues/190),
`wsh-objects`) mounts on it (`@johnhenry/browsermesh-objects`). Code: `packages/browsermesh-apps/src/protocol-channel.mjs`
(over `mesh-channel.mjs`, #271), `protocol-roots.mjs` (per-root authorisation) and
`protocol-stream.mjs` (bodies larger than one message).

## The interface

```
channel.peer                          verified identity of the other end (a public key)
channel.maxMessageBytes               payload budget for one message
channel.send(obj, { signal })         structured message, Uint8Array included
channel.onMessage(cb)                 cb(obj, { peer }); a returned promise slows the sender
channel.request(method, params, { signal, onProgress, onSent, timeoutMs })  -> Promise<result>
channel.notify(method, params)
channel.onRequest(method, handler)    handler(params, { peer, signal, progress })
channel.onNotification(method, handler)  handler(params, { peer })
channel.onClose(cb)
channel.close()
```

`assertProtocolChannel(x)` checks the shape. Beyond the issue's list this adds
`onNotification` (a notify needs a receiver) and `close`. Notes:

- `peer` is the key the session is bound to, never read from a message.
- `onSent()` is called once, when the transport has taken the first frame of the request. A request that fails without it
  never left this node (the transport refused the frame, or the link ended first); one that fails after it may have reached the
  peer.
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
- Wire: requests `mesh.protocol.open` / `mesh.protocol.list`, notification `mesh.protocol.close` (`{ name, reason? }`), protocol methods as `<name>/<method>`, raw messages as `{ $p: name, b }`. A peer without protocol support answers -32601; a peer without the channel refuses at the handshake.
- Why the other end closed: `channel.close('some text')` tells the other end the text when it is one to 64 printable ASCII characters (an `Error`, a longer string or anything else is not sent), and that end reads it as `channel.remoteReason` (`undefined` when none was given, or an older peer closed it). The field is optional on the wire; a peer that predates it ignores it. A layered protocol uses it to tell a revocation (`'authorization revoked'`) from a stop.

## Mounting a remote-object layer (`wsh-objects`)

Built: `@johnhenry/browsermesh-objects` (`exposeObjectsOnMesh`, `openObjectsOnMesh`; `examples/19`). `wsh-objects` is built in wsh with a transport-neutral core: handles and path addressing, `get`/`call`/`set`, events by subscription, one-way callbacks, bounded snapshots. Its transport needs map onto the interface above as follows (the design table; what the package does is below it):

| `wsh-objects` need | Protocol channel |
|---|---|
| request / response with cancel and progress | `request` with `signal` / `onProgress`; handler `ctx.signal` / `ctx.progress` |
| events by subscription | `notify` from the server, `onNotification` on the client (as the counter's `changed`) |
| bytes in values and snapshots | native `Uint8Array` |
| bounded snapshots | `maxMessageBytes`, plus the link's credit window bounding a slow reader |
| who is calling | `ctx.peer` on every handler |
| close / lease cleanup | `onClose` |

What the package does: `exposeObjectsOnMesh(service, { roots, allow })` is `serveProtocol('objects', channel => ...)`. The layer's own messages (its requests, responses, progress, events and callbacks, JSON-RPC shaped) travel as the channel's raw messages (`send` / `onMessage`), through wsh's `createDuplexPeer`, not as `request` / `notify` of the channel; the table above is the mapping that was designed, and the raw-message form is what wsh's layer needs and what was built. Every operation is judged by its own action, `objects:<root>:get|call|set|on`, through `createRootAuthorizer` for the channel's verified peer, after wsh's allow-lists (the `protocol:objects:open` scope only gates opening the layer); a revoked grant ends what it allowed. See the package README and [`security.md`](security.md#mesh-rpc-the-message-channel-and-the-protocol-seam).

What was missing when this note was written, and is now there:

- the object layer itself: wsh (`@johnhenry/wsh/objects`, from 0.46; events, handles and callbacks from 0.48);
- subscription flow control above the raw notify: the layer's bounded queue (`maxQueuedEvents`) waits on the channel's credit and drops, counted, what a slow reader cannot take; the adapter makes the write wait for that credit and cuts off a peer that keeps asking without reading;
- a way to learn a peer supports the channel without trying: `channel-advertisement.mjs` (`channelAdvertisement()` goes into what a peer announces, `peerSupportsFromAdvertisements(lookup)` is the `peerSupports` hook; a peer that advertises nothing is still tried, and an advertisement is a claim, not an authorisation). Nothing publishes the advertisement for you yet: a deployment adds it to its runtime-registry record (as pod hosts add `pod-host`);
- per-root authorisation: `createRootAuthorizer` and `service.api.rootAuthorizer(protocol)` (`protocol-roots.mjs`);
- streams larger than one message: `createStreamLayer(channel)` (`protocol-stream.mjs`), a per-stream byte window the receiver grants; (a protocol that sends one large message instead is carried by the channel's own chunking up to `maxMessageBytes`);
- a real-WebRTC test of the channel: `tests/browser/protocol-channel.spec.mjs` (and `tests/browser/objects.spec.mjs` for the object layer), in Chromium, Firefox and WebKit, and a real-peer test under `packages/browsermesh-objects/test/real-peer`.

Still not built here: MCP across the mesh (#334 item 3) and wsh over a mesh link (reaching a browser through a mesh peer, #334 item 7).

## The retired remote-eval spike

An earlier browser-extension spike evaluated a JavaScript string in a page for its `exec`. That cannot work under a strict Content-Security-Policy and cannot be allow-listed by path, and the extension never ran in a real Chromium either. The spike has been removed; [what was learned](hosted-pods.md#what-was-learned-from-the-mv3-extension-spike) is in the hosted pods document. No published package imported it, so nothing published reached that `exec`.
