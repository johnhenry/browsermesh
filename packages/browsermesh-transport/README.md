# browsermesh-transport

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-transport.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-transport)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-transport.svg)](LICENSE)

WebSocket, WebRTC, WebTransport, relay, and streaming adapters for BrowserMesh.

## Why this exists

A mesh peer needs to move bytes to another peer, but browsers offer several incompatible ways to do that (WebRTC data channels, plain WebSockets, WebTransport) with wildly different connection-setup, NAT-traversal, and reliability characteristics -- and no single one works in every environment. `browsermesh-transport` exists so the rest of the mesh doesn't have to care which one is in play: `MeshTransportNegotiator`/`TransportFactory` try each candidate in a preferred order (`webrtc` → `wsh-wt` → `wsh-ws`) and hand back one object shaped like `MeshTransport`, regardless of which underlying protocol won. `WebRTCMeshManager` handles the harder WebRTC-specific problem of multiple independent connections per peer; `GatewayNode`/`RouteTable` and `MeshRelayClient` cover routing through and relaying via a gateway when a direct connection isn't possible. It depends only on `browsermesh-primitives`, for the shared `MESH_TYPE`/`MESH_ERROR` types its transports and streams report.

## Used by

`@johnhenry/browsermesh-apps` treats this package as an optional peer, reaching for it lazily: `webrtc-negotiator.mjs` `import()`s `WebRTCTransportAdapter` at connection time, and `mesh-bootstrap.mjs` does the same to wire a real transport negotiator into `createMeshNode()`. `@johnhenry/browsermesh-priority-mux` is a different kind of companion -- it has no hard dependency on this package at all, but is purpose-built to wrap this package's `WebSocketTransport` (or anything shaped the same way) with application-level priority scheduling, since a WebSocket -- unlike the `WebRTCTransport` here, which gets a second data channel almost for free -- is one ordered byte stream with no way to stop a bulk transfer from blocking an urgent message behind it. See `browsermesh-priority-mux`'s README for the full rationale.

## Provenance

Extracted from a private monorepo (previously `packages/browsermesh-transport`), where it was manually published to npm, unscoped, as `browsermesh-transport@0.1.0` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.


## Modules

| Module | Key Exports |
|--------|-------------|
| transport | `MeshTransport`, `MockMeshTransport`, `MeshTransportNegotiator` |
| websocket | `WebSocketTransport`, `WebRTCTransport`, `WebTransportTransport`, `NATTraversal`, `TransportFactory` |
| wire-data | `encodeWireData`, `isWireNative` |
| webrtc | `WebRTCPeerConnection`, `WebRTCMeshManager`, `WebRTCTransportAdapter` |
| webtransport | `WebTransportBridge`, `WebTransportAdapterFactory` |
| relay | `MeshRelayClient`, `MockRelayServer` |
| gateway | `GatewayNode`, `GatewayDiscovery`, `RouteTable` |
| streams | `MeshStream`, `StreamMultiplexer` |
| cross-origin | `CrossOriginBridge`, `CrossOriginHandshake`, `RateLimiter` |
| wsh-bridge | `MeshWshBridge` (syncs a `WshKeyStore` with a `MeshIdentityManager`; the link layer does not use it) |
| wsh-frames | `encodeFrame`, `FrameDecoder`, `WshFrameError`, `DEFAULT_MAX_FRAME_BYTES` |
| wsh-links (subpath `@johnhenry/browsermesh-transport/wsh`) | `WshPeerLinks`, `WshLink`, `WshLinkError`, `createWshTransportFactory`, `rendezvousId` |
| wsh-services (subpath `/wsh`) | `WshServices`, `servicesRendezvousId`, `WSH_SERVICES_GRANTS` (a stock wsh client may use a pod's objects and MCP tools: off by default, permitted only by the registry; needs `@johnhenry/wsh` 0.50 or later; see `docs/design/wsh-services-on-a-pod.md`) |
| wsh-relay (subpath `/wsh`) | `WshRelay`, `connectWshServicesViaRelay` |
| wsh-pod-transport (subpath `/wsh`) | `WshPodTransport` (a `Pod` `TransportAdapter`) |
| wsh-in-process (subpath `@johnhenry/browsermesh-transport/wsh-in-process`, **Node only**) | `createInProcessPipeRelay` (tests and examples) |

`@johnhenry/browsermesh-transport/wsh` re-exports every `wsh-*` module above (the two that need no wsh as well).
See [Bundling for the browser](#bundling-for-the-browser).
| wisp | `WispTransport` |
| channel-relay | `ChannelRelay` |

## Install

```bash
npm install @johnhenry/browsermesh-transport @johnhenry/browsermesh-primitives
```

## Bundling for the browser

The main entry (`@johnhenry/browsermesh-transport`, `src/index.mjs`) is bundlable for a browser with
`@johnhenry/wsh` **absent**: nothing it reaches imports a `@johnhenry/wsh` specifier or a Node-only module,
and its only bare specifier is the `@johnhenry/browsermesh-primitives` peer. A test pins that
(`test/main-entry-graph.test.mjs` reads the import graph the way a bundler does), and the browser suite loads
the entry in a page whose import map has no wsh at all (`tests/browser/transport-no-wsh.spec.mjs`). So an
application that never uses wsh needs no stub, no alias and no peer: leave `@johnhenry/wsh` uninstalled.

What needs wsh lives behind its own subpath, imported only by code that uses it:

| You use | Import from | Needs `@johnhenry/wsh` |
| --- | --- | --- |
| wsh peer links (`WshPeerLinks`, `WshLink`, `createWshTransportFactory`), `WshPodTransport` | `@johnhenry/browsermesh-transport/wsh` | 0.45 or later, on the first `connect()` / `listen()` |
| wsh services over a mesh channel, the relaying pod (`WshServices`, `WshRelay`, `connectWshServicesOverMesh`, `connectWshServicesViaRelay`) | `@johnhenry/browsermesh-transport/wsh` | 0.50 or later, on first use |
| the in-process test relay (`createInProcessPipeRelay`) | `@johnhenry/browsermesh-transport/wsh-in-process` (Node only) | any wsh with the pipe relay |

`@johnhenry/wsh` is an optional peer (`"*"`: any version satisfies it, so a consumer that pins an older wsh for
another reason does not get a second, nested copy). The floors above are checked when the feature is used, and a
wsh that is missing or too old fails there with a `WshLinkError` whose code is `WSH_UNAVAILABLE`. Importing
`/wsh` never loads wsh: its modules import it lazily with literal specifiers, so a bundler can split it out and a
page that never links over wsh never fetches it. `./wsh-in-process` has only a `node` export condition: a
bundler for the browser cannot resolve it (it fails clearly, instead of pulling wsh's Node-only pipe relay in).

### Moving off the old names (0.10 and earlier)

Up to 0.10 the main entry also re-exported `WshPeerLinks`, `WshLink`, `WshLinkError`, `createWshTransportFactory`,
`rendezvousId`, `initiatorWins`, `resolveCredential`, `LINK_USERNAME_PREFIX`, `usernameForPodId`, `WshServices`,
`servicesRendezvousId`, `WSH_SERVICES_GRANTS`, `wshObjectActionFor`, `connectWshServicesOverMesh`, `WshRelay`,
`WSH_RELAY_PROTOCOL`, `connectWshServicesViaRelay` and `WshPodTransport`. For one release (0.11) they still resolve
from the package root **where the `node` export condition applies** (Node, and a bundler built for Node), so a
Node program keeps working unchanged. Anywhere else (a bundler or import map for the browser, a vendored copy of
`src/`) the root no longer carries them: import them from `@johnhenry/browsermesh-transport/wsh`. The next
minor removes the root's `node` shim; change the import before then. Everything else on the main entry is
unchanged (`MeshWshBridge`, `encodeFrame`, `FrameDecoder`, `WshFrameError`, `podIdToFingerprint`,
`fingerprintToPodId` and `podIdFromRawKey` stay), and `TransportFactory.create('wsh', { links, peerPodId })` now
builds the link through `links.link(peerPodId)` instead of importing it.

## Usage

```js
import { MeshTransport, WebSocketTransport, StreamMultiplexer } from '@johnhenry/browsermesh-transport';
```

## What `send()` puts on the wire

`RTCDataChannel.send()` and `WebSocket.send()` accept only a string or binary
and quietly turn anything else into the text `"[object Object]"`. Every
transport here therefore sends strings and binary (`ArrayBuffer`, typed arrays,
`Blob`) unchanged and any other value as its JSON text (`encodeWireData()`; it
throws a `TypeError` for `undefined` or a function rather than send the text
`"undefined"`). The receiving side gets a string; a consumer that wants objects
parses it (`@johnhenry/browsermesh-apps`' `ctx.onIncomingData()` does). A custom
`MeshTransport` should follow the same rule.

`WebRTCTransport.send(data, { channel })` takes `'control'` (default) or
`'bulk'` and falls back to control when the bulk channel is not open.

## Binding a WebRTC connection to the pod identities (opt-in)

Offer and answer travel through signalling, and a server on that path can swap
them. Pass `identity` (a `PodIdentity`) to `WebRTCPeerConnection` (or to
`WebRTCMeshManager`, which hands it to every connection) and each side proves
possession of its pod key, on the control data channel, over a transcript that
contains both pod ids and the DTLS fingerprints of **both** session
descriptions (`identity-binding.mjs`: `extractDtlsFingerprints`,
`bindingTranscript`, `createBindingProof`, `verifyBindingProof`; signed bytes
are `"browsermesh/webrtc-binding/v1\n"` plus canonical JSON, with the signer's
role included so a proof cannot be reflected). The proof carries the public
key, which must hash to `remotePodId`, the pod id claimed in signalling.

- The connection becomes `connected` (and `send()` works) only after the peer's
  proof verified; before that only the proof frame is accepted, and anything
  else is dropped and counted (`droppedUnbound`). `bound` is true afterwards.
- A proof that does not verify (swapped description, key that is not the claimed
  pod, reflected or replayed proof) closes the connection and reports an
  `identity binding failed: <reason>` error through `onError()`;
  `bindingFailure` holds the reason.
- A peer that sends no proof is closed after `bindingTimeoutMs` (default
  10000). With `requirePeerBinding: false` such a peer (an older build) is
  accepted unbound (`bound` stays false), while a proof that fails is still
  fatal.
- Nothing changes without `identity`. An older peer that receives the proof
  frame sees one extra JSON message of type `mesh:bind` on the control channel.
  `createMeshNode()` does not enable this yet.

This is verified here with an in-memory duplex and fixed vectors; it has not
been run over a real `RTCPeerConnection` in a browser (see issue #270).

## ICE servers: none by default, and why

`DEFAULT_ICE_SERVERS` is empty. With no STUN or TURN server a peer gathers
host candidates only, which is enough for two devices on the same network and
contacts nobody. A public STUN server learns the peer's public IP address, and
that it is about to pair with someone, on every connection attempt; a library
should not make that choice for an application, so it is opt-in.

Peers on different networks (behind NAT) usually need a STUN server, and
restrictive NATs need TURN. Supply your own:

```js
const mesh = new WebRTCMeshManager({
  localPodId,
  iceServers: [
    { urls: 'stun:stun.example.com:3478' },
    { urls: 'turn:turn.example.com:3478', username, credential },
  ],
});
```

If you accept the disclosure, `PUBLIC_STUN_SERVERS` is a ready-made public
list (`iceServers: [...PUBLIC_STUN_SERVERS]`). An explicit `iceServers: []`
is honoured as "none". When a connection with no ICE servers fails, a note
explaining the above is logged once per process (through `onLog` if given,
otherwise `console.warn`).

## TURN-only pods: `iceTransportPolicy`

By default a pod that has configured a TURN server still gathers host and
server-reflexive candidates, so its public IP reaches every peer it negotiates
with. To avoid that, pass `iceTransportPolicy: 'relay'`; the browser then
gathers only relayed (TURN) candidates:

```js
const mesh = new WebRTCMeshManager({
  localPodId,
  iceServers: [{ urls: 'turns:turn.example.com:443', username, credential }],
  iceTransportPolicy: 'relay',
});
```

It is accepted by `WebRTCPeerConnection`, `WebRTCMeshManager`, `WebRTCTransport`
(also as `config.iceTransportPolicy`) and `TransportFactory` (a default for the
`'webrtc'` transports it creates), and forwarded verbatim to
`RTCPeerConnection`. `'relay'` with no `turn:`/`turns:` entry in `iceServers`
throws at construction, because relay-only gathering without a TURN server
yields zero candidates and the connection would just hang. Leaving the option
out keeps the browser default (`'all'`).

## Size-bucket padding and send jitter (opt-in)

A relay that only sees ciphertext still learns exact payload sizes, which for
short agent messages distinguishes message types. Padding rounds each message
up to a bucket size (`padTo()`/`unpad()` in `@johnhenry/browsermesh-primitives`;
default buckets 256 / 1024 / 4096 / 16384 bytes, larger payloads round up to a
multiple of 16384). It is off by default. Hiding sizes from a relay requires
padding *inside* the end-to-end seal:

- **Group-key envelopes** (`@johnhenry/browsermesh-core`):
  `groupKeys.encrypt(bytes, { padding: true })` and
  `groupKeys.decrypt(ct, iv, epoch, { padding: true })`.
- **`WebSocketTransport`** (what talks to a relay): `new WebSocketTransport({ url,
  padding: true })` sends every frame as a binary frame padded to a bucket
  (text and binary round-trip; both ends must enable it) and `jitterMs: 50`
  adds a random 0..50 ms delay to each send, order preserved. A transport-level
  frame is visible to whoever terminates the WebSocket, so on its own this
  hides sizes from network observers, not from the relay; combine it with
  padding inside the seal for relay-blind payloads.

Constant-rate cover traffic is deliberately not provided.

## Sealed peer links over wsh

A mesh link can be a [wsh](https://github.com/johnhenry/wsh) session: key login
in both directions, a host key the dialler pins to the pod id it meant to
reach, a login bound to the connection, and a session sealed end to end so a
relay can neither read nor alter it. A pod's Ed25519 key is its wsh identity
and the pod id a peer claims must be the hash of the key wsh authenticated, so
the sender of every message on a link is that key. **Off by default**; nothing
changes for code that does not ask for it. Design and threat model:
[`docs/design/wsh-peer-link.md`](../../docs/design/wsh-peer-link.md); what is and
is not protected: [`docs/security.md`](../../docs/security.md).

Import the link code from `@johnhenry/browsermesh-transport/wsh` and install the optional peer,
`npm install @johnhenry/wsh` (0.45 or later for links, 0.50 or later for the services; developed against 0.51). It is
imported lazily on the first `listen()` / `connect()`, so a page that never
uses a wsh link loads none of it. See [Bundling for the browser](#bundling-for-the-browser).

Between two browsers neither can listen, so a pod that wants to be reached
waits at its own rendezvous id on a wsh **pipe relay** (a relay that copies
bytes and vouches for nothing; `createPipeRelay` in `@johnhenry/wsh/pipe-relay`)
and a pod that wants to reach it dials that id:

```js
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { WshPeerLinks } from '@johnhenry/browsermesh-transport/wsh'

const identity = await PodIdentity.generate()
const links = new WshPeerLinks({
  identity,                                   // or { podId, signer } for a key held elsewhere
  relays: ['wss://relay.example/'],           // pipe relay base URL(s)
  authorize: ({ podId }) => allowed.has(podId), // who may link to this pod. Default: nobody
})
await links.listen()                          // be reachable
await links.connect(otherPodId)               // reach a peer; redialled if the link is lost
links.on('message', ({ from, data }) => { /* `from` is the authenticated pod id */ })
await links.send(otherPodId, { hello: 'sealed' })   // resolves when the stream accepted it
```

**For a `Pod`**: `WshPodTransport` is a `TransportAdapter`, so a `Pod` uses it
unchanged. `from` is set to the authenticated key and a message that names
another sender is dropped.

```js
const transport = new WshPodTransport({ identity, relays, authorize, peers: [otherPodId] })
await pod.boot({ identity, transport })
```

**For `PeerNode`** (mesh-rpc, mesh-sync, mesh-relay and the rest): use
`createMeshNode({ wsh: { relays } })` from `@johnhenry/browsermesh-apps`, or
register the adapter yourself:

```js
negotiator.registerAdapter('wsh', createWshTransportFactory(links))   // endpoint = the peer's pod id
```

### Selection

`'wsh'` is a `TRANSPORT_TYPES` member but is in no default preference order.
Opt in by listing it (`new MeshTransportNegotiator({ preferenceOrder: ['wsh',
'webrtc'] })`) or by requiring it: `new MeshTransportNegotiator({ require: 'wsh'
})`, or `negotiate(endpoints, auth, { require: 'wsh' })`. With `require` only
the wsh adapter is tried and its failure is the failure, **never a fallback to
an unsealed transport**. There is no setting that makes a wsh link plain:
sealing is always on and checked after login.
`TransportFactory.create('wsh', { links, peerPodId })` returns an unconnected
`WshLink`.

### What the link does

- **Frames**: `u32 length | u8 kind | payload` on one named endpoint (`mesh`);
  `maxFrameBytes` (default 1 MiB) is checked on the header, before the payload
  is buffered.
- **Backpressure**: writes wait for the endpoint's credit window; `send()`
  resolves when the stream accepted the frame. Pending sends queue up to
  `maxQueuedBytes` (default 4 MiB), then reject with `WSH_BACKPRESSURE`. A slow
  reader (a handler that returns a promise, or `pause(podId)`) stalls its sender
  at a bounded amount.
- **Simultaneous dial**: if two pods dial each other at once, exactly one link
  survives, the one the lower pod id initiated; nothing is reported as down.
- **Liveness and reconnect**: the wsh client pings and closes on a missed pong
  (`keepAlive`); a kept peer is redialled with backoff (`reconnect`), a refusal
  or host key mismatch stops it.
- **Errors**: `WshLinkError` with a stable `code` (`WSH_HOSTKEY_MISMATCH`,
  `WSH_REFUSED` with `reason`, `WSH_NOT_SEALED`, `WSH_UNREACHABLE`,
  `WSH_SEAL_FAILED`, `WSH_FRAME_TOO_LARGE`, `WSH_BAD_FRAME`, `WSH_BACKPRESSURE`,
  `WSH_CLOSED`, `WSH_UNAVAILABLE`). The listening side gets wsh's `onRefused`
  reasons through the `refused` event (plus `identity-mismatch`).

### Testing without a network

```js
import { createInProcessPipeRelay } from '@johnhenry/browsermesh-transport/wsh-in-process'
const env = await createInProcessPipeRelay()      // wsh's real pipe relay, in this process
new WshPeerLinks({ identity, relays: ['wss://relay.invalid'], WebSocket: env.WebSocket, authorize })
// env.recorded holds every byte the relay copied; env.tap can alter them; env.dropAll() ends every pipe
```

It is a separate subpath, with only a `node` export condition, because it imports wsh's pipe relay, which has a
Node-only listener a browser bundle must not follow.

### Bundle size

Measured with esbuild (minified, browser, code splitting, `@johnhenry/browsermesh-primitives`
external), size of what is added:

| | raw | gzip |
| --- | ---: | ---: |
| a page that imports only `MeshTransportNegotiator` / `WebSocketTransport` (no wsh link): added to the main chunk | +0.56 kB | +0.16 kB |
| a page that imports `WshPeerLinks`: the link code in the main chunk | 21.1 kB | 7.8 kB |
| lazy, dialling role (`@johnhenry/wsh` client): shared wsh core + client | 170.6 kB | 52.8 kB |
| lazy, listening role (`@johnhenry/wsh/memory`): shared wsh core + host | 237.4 kB | 74.5 kB |
| lazy, both roles | 259.2 kB | 82.9 kB |
| lazy, only where WebCrypto has no ML-KEM (`@noble/post-quantum`) | +19.2 kB | +7.6 kB |

The wsh chunks load on the first `connect()` / `listen()`; a page that never
links over wsh never fetches them. These are one-off measurements of wsh 0.45.0,
not a budget this repository enforces.

## License

MIT
