# browsermesh-transport

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-transport.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-transport)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-transport.svg)](LICENSE)

WebSocket, WebRTC, WebTransport, relay, and streaming adapters for BrowserMesh.

## Why this exists

A mesh peer needs to move bytes to another peer, but browsers offer several incompatible ways to do that (WebRTC data channels, plain WebSockets, WebTransport) with wildly different connection-setup, NAT-traversal, and reliability characteristics -- and no single one works in every environment. `browsermesh-transport` exists so the rest of the mesh doesn't have to care which one is in play: `MeshTransportNegotiator`/`TransportFactory` try each candidate in a preferred order (`webrtc` → `wsh-wt` → `wsh-ws`) and hand back one object shaped like `MeshTransport`, regardless of which underlying protocol won. `WebRTCMeshManager` handles the harder WebRTC-specific problem of multiple independent connections per peer; `GatewayNode`/`RouteTable` and `MeshRelayClient` cover routing through and relaying via a gateway when a direct connection isn't possible. It depends only on `browsermesh-primitives`, for the shared `MESH_TYPE`/`MESH_ERROR` types its transports and streams report.

## Used by

`@johnhenry/browsermesh-apps` treats this package as an optional peer, reaching for it lazily: `webrtc-negotiator.mjs` `import()`s `WebRTCTransportAdapter` at connection time, and `mesh-bootstrap.mjs` does the same to wire a real transport negotiator into `createMeshNode()`. `@johnhenry/browsermesh-priority-mux` is a different kind of companion -- it has no hard dependency on this package at all, but is purpose-built to wrap this package's `WebSocketTransport` (or anything shaped the same way) with application-level priority scheduling, since a WebSocket -- unlike the `WebRTCTransport` here, which gets a second data channel almost for free -- is one ordered byte stream with no way to stop a bulk transfer from blocking an urgent message behind it. See `browsermesh-priority-mux`'s README for the full rationale.

## Provenance

Extracted from the private `clawser` monorepo (previously `packages/browsermesh-transport`), where it was manually published to npm, unscoped, as `browsermesh-transport@0.1.0` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.


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
| wsh-bridge | `MeshWshBridge` |
| wisp | `WispTransport` |
| channel-relay | `ChannelRelay` |

## Install

```bash
npm install @johnhenry/browsermesh-transport @johnhenry/browsermesh-primitives
```

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

## License

MIT
