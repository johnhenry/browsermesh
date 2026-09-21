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

## License

MIT
