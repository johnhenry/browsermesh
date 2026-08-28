# browsermesh-transport

WebSocket, WebRTC, WebTransport, relay, and streaming adapters for BrowserMesh.

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
import { MeshTransport, WebSocketTransport, StreamMultiplexer } from 'browsermesh-transport';
```

## License

MIT
