# browsermesh-pod

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-pod.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-pod)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-pod.svg)](LICENSE)

Pod base class for browser execution contexts with Ed25519 identity, BroadcastChannel discovery, and peer messaging.

A Pod is any browser execution context (window, iframe, worker, service worker) that can execute code, receive messages, and be discovered/addressed. This package provides the standalone base class with zero framework dependencies.

Pods automatically generate an Ed25519 cryptographic identity, detect their execution context, discover same-origin peers via BroadcastChannel, and establish roles (autonomous, child, peer).

## Contents

- [Why this exists](#why-this-exists)
- [Used by](#used-by)
- [Provenance](#provenance)
- [Install](#install)
- [Quick Start](#quick-start)
- [Boot Sequence](#boot-sequence)
- [Boot Options](#boot-options)
- [API](#api)
  - [Getters](#getters)
  - [Methods](#methods)
  - [Events](#events)
  - [Subclass Hooks](#subclass-hooks)
- [Runtime Convenience Functions](#runtime-convenience-functions)
- [Pod Kinds](#pod-kinds)
- [Capabilities](#capabilities)
- [Wire Protocol](#wire-protocol)
- [WebSocketTransport (relay-backed)](#websockettransport-relay-backed)
- [InjectedPod](#injectedpod)
- [Peer Dependency](#peer-dependency)
- [License](#license)

## Why this exists

A mesh needs *something* to be the addressable unit -- the thing with an identity, a place in the topology, and a lifecycle other peers can observe. In a browser that unit is naturally an execution context (a tab, an iframe, a worker), but the platform gives you no way to ask "who else is running near me" or "am I a top-level window or something a parent spawned." `Pod` is that missing base class: it generates an identity, classifies its own context (`window`, `iframe`, `worker`, `service-worker`, ...), runs a 6-phase boot sequence to find and be found by same-origin peers, and gives every higher-level package in this monorepo (and outside it) a stable `podId`/`role`/`peers` surface to build on, without dragging in any framework or transport of its own. It depends on nothing but `browsermesh-primitives`, deliberately -- boot and identity should work the same whether or not a mesh transport, sync engine, or kernel is present.

## Used by

`@johnhenry/browsermesh-embed`'s `EmbeddedPod` extends `Pod` directly, layering a `sendMessage`/message-log widget on top of the same boot sequence and peer discovery this package provides -- see that package's README for what it adds.

## Provenance

Previously maintained as an independent, standalone repository and published to npm, unscoped, as `browsermesh-pod@0.2.1` (initial release `0.1.0`, 2026-03-15), with its own CI already wired up (tests, CodeQL, dependency review). Imported into the `@johnhenry/browsermesh` monorepo via `git subtree` -- preserving its full commit history -- and rescoped to `@johnhenry/browsermesh-pod`; the version restarts at `0.0.0` per family convention.

## Install

```bash
npm install @johnhenry/browsermesh-pod @johnhenry/browsermesh-primitives
```

`browsermesh-primitives` is a peer dependency (provides Ed25519 identity generation).

## Quick Start

```js
import { Pod } from '@johnhenry/browsermesh-pod'

const pod = new Pod()
await pod.boot()

console.log(pod.podId)      // base64url Ed25519 public key hash
console.log(pod.kind)        // 'window', 'worker', 'iframe', etc.
console.log(pod.role)        // 'autonomous', 'peer', or 'child'
console.log(pod.peers.size)  // number of discovered peers

pod.on('message', (msg) => {
  console.log('Received:', msg.payload)
})

// Send to a specific peer
pod.send(otherPodId, { text: 'hello' })

// Broadcast to all peers
pod.broadcast({ text: 'hello everyone' })

await pod.shutdown()
```

## Boot Sequence

The 6-phase boot sequence runs automatically when you call `pod.boot()`:

| Phase | Name | Action |
|-------|------|--------|
| 0 | Install Runtime | Generate Ed25519 identity, detect kind & capabilities |
| 1 | Install Listeners | Attach message handlers, call `_onInstallListeners()` hook |
| 2 | Self-Classification | Detect parent/opener relationships |
| 3 | Parent Handshake | Send `POD_HELLO` to parent/opener, wait for `POD_HELLO_ACK` |
| 4 | Peer Discovery | Announce on BroadcastChannel, collect peer responses |
| 5 | Role Finalization | Determine role, call `_onReady()` hook, emit `'ready'` event |

State transitions: `idle -> booting -> ready -> shutdown`

## Boot Options

```js
await pod.boot({
  identity,           // PodIdentity — skip generation, reuse existing
  discoveryChannel,   // string — BroadcastChannel name (default: 'pod-discovery')
  handshakeTimeout,   // number — ms to wait for parent ACK (default: 1000)
  discoveryTimeout,   // number — ms to wait for peer responses (default: 2000)
  globalThis,         // object — override globalThis (for testing)
})
```

## API

### Getters

| Getter | Type | Description |
|--------|------|-------------|
| `podId` | `string \| null` | Base64url Ed25519 public key hash |
| `identity` | `PodIdentity \| null` | Ed25519 key pair wrapper |
| `capabilities` | `PodCapabilities \| null` | Detected runtime capabilities |
| `kind` | `PodKind \| null` | Execution context classification |
| `role` | `PodRole` | `'autonomous'`, `'child'`, or `'peer'` |
| `state` | `PodState` | `'idle'`, `'booting'`, `'ready'`, or `'shutdown'` |
| `peers` | `Map<string, object>` | Copy of known peers (podId -> info) |

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `boot` | `async boot(opts?)` | Run 6-phase boot sequence |
| `shutdown` | `async shutdown(opts?)` | Broadcast goodbye, close channels, clear peers |
| `send` | `send(targetPodId, payload)` | Send message to a specific peer |
| `broadcast` | `broadcast(payload)` | Send message to all peers (address: `'*'`) |
| `on` | `on(event, cb)` | Register event listener |
| `off` | `off(event, cb)` | Remove event listener |
| `toJSON` | `toJSON()` | Serializable snapshot of pod state |

### Events

| Event | Data | When |
|-------|------|------|
| `phase` | `{ phase, name }` | Each boot phase starts |
| `ready` | `{ podId, kind, role }` | Boot completes |
| `shutdown` | `{ podId }` | Pod shuts down |
| `error` | `{ phase, error }` | Boot phase fails |
| `peer:found` | `{ podId, kind }` | New peer discovered |
| `peer:lost` | `{ podId }` | Peer departed |
| `message` | `{ type, from, to, payload, ts }` | Incoming message |

### Subclass Hooks

| Hook | Phase | Description |
|------|-------|-------------|
| `_onInstallListeners(g)` | 1 | Install additional message handlers |
| `_onReady()` | 5 | Boot complete callback |
| `_onMessage(msg)` | -- | Handle incoming targeted message |

## Runtime Convenience Functions

```js
import { installPodRuntime, createRuntime, createClient, createServer } from '@johnhenry/browsermesh-pod'

// Create and boot a pod (createRuntime is an alias)
const pod = await installPodRuntime({ context: globalThis })

// Lightweight client with short discovery timeout
const client = await createClient({ discoveryTimeout: 500 })

// Server-oriented pod with longer timeouts
const server = await createServer({ discoveryTimeout: 5000 })
```

## Pod Kinds

`detectPodKind(globalThis)` returns one of:

| Kind | Detection |
|------|-----------|
| `service-worker` | `instanceof ServiceWorkerGlobalScope` |
| `shared-worker` | `instanceof SharedWorkerGlobalScope` |
| `worker` | `instanceof WorkerGlobalScope` |
| `worklet` | `instanceof AudioWorkletGlobalScope` |
| `server` | No `window` or `document` |
| `iframe` | `window !== window.parent` |
| `spawned` | `window.opener` is set |
| `window` | Default (top-level window) |

## Capabilities

`detectCapabilities(globalThis)` returns:

```js
{
  messaging: { postMessage, messageChannel, broadcastChannel, sharedWorker, serviceWorker },
  network:   { fetch, webSocket, webTransport, webRTC },
  storage:   { indexedDB, cacheAPI, opfs },
  compute:   { wasm, sharedArrayBuffer, offscreenCanvas },
}
```

## Wire Protocol

| Constant | Value | Purpose |
|----------|-------|---------|
| `POD_HELLO` | `'pod:hello'` | Discovery announcement |
| `POD_HELLO_ACK` | `'pod:hello-ack'` | Discovery response |
| `POD_GOODBYE` | `'pod:goodbye'` | Graceful departure |
| `POD_MESSAGE` | `'pod:message'` | Inter-pod message |
| `POD_RPC_REQUEST` | `'pod:rpc-request'` | RPC call |
| `POD_RPC_RESPONSE` | `'pod:rpc-response'` | RPC result |

Message factories: `createHello()`, `createHelloAck()`, `createGoodbye()`, `createMessage()`, `createRpcRequest()`, `createRpcResponse()`.

## WebSocketTransport (relay-backed)

`BroadcastChannelTransport` only reaches same-origin tabs. `WebSocketTransport` is the adapter that lets a `Pod` run anywhere a WebSocket client exists — a Node process, a browser, or a V8 isolate (workerd / Cloudflare Workers) — and still join the mesh, by speaking the `browsermesh-servers` relay/signaling wire protocol (`register`/`registered`, `relay`/`relayed`, `peers`/`peer-joined`/`peer-left`, `ping`/`pong`, `error`). This is what unlocks "hosted pods" (see [issue #185](https://github.com/johnhenry/browsermesh/issues/185)): a pod running on a machine someone else operates, reachable over the same relay a browser tab would use.

```js
import { Pod, WebSocketTransport } from '@johnhenry/browsermesh-pod'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'

// Pod generates its own identity during boot() unless one is supplied; the
// transport needs the same podId up front to register with the relay, so
// generate (or load) the identity first.
const identity = await PodIdentity.generate()

const transport = new WebSocketTransport({
  url: 'wss://relay.example.com',
  podId: identity.podId,
  // WebSocket: globalThis.WebSocket is used by default; inject your own
  // (e.g. the `ws` package, or a fake) for testing or non-browser runtimes
  // that don't expose a global WebSocket.
  peersFromSignaling: true,
  signalingUrl: 'wss://signaling.example.com',
})

const pod = new Pod()
await pod.boot({ identity, transport })
```

Key properties, driven directly by the relay server's shape:

- **Point-to-point only.** The relay server forwards `{type:'relay', target, envelope}` to exactly one registered peer — it has no broadcast primitive. `send(msg)` relays point-to-point when `msg.to` names a specific peer, and fans a `to`-less (or `to: '*'`) message like discovery's `hello`/`goodbye` out point-to-point to every peer id the transport currently knows about (`get knownPeers`).
- **`knownPeers` has two sources**: every podId seen as the sender of a `relayed` envelope, and — when `peersFromSignaling: true` and `signalingUrl` is set — a second WebSocket connection to the signaling server that consumes its `peers` snapshot plus `peer-joined`/`peer-left` events. Seeding from signaling matters for discovery specifically: without it, two freshly-registered pods' first `hello` broadcasts have nobody to fan out to.
- **Reconnects with exponential backoff** (`reconnect: { baseMs: 250, maxMs: 10000, maxAttempts: Infinity }` by default) and re-registers on reconnect; `ready` is `false` while disconnected, and `close()` clears all pending timers.
- **Protocol note**: the relay/signaling servers' wire protocol uses `target`/`source` field names for forwarding, not `to`/`from` — `WebSocketTransport` speaks the servers' real field names and only remaps to `from` on the Pod message shape when delivering to `onMessage()`.

See `examples/12-hosted-pod-over-websocket.mjs` in the monorepo root for a full runnable example (two pods discovering each other and exchanging a message over a simulated relay, no network required).

## InjectedPod

Lightweight subclass for Chrome extension injection or bookmarklet use. Adds page text extraction, structured data extraction, and a visual overlay indicator.

```js
import { InjectedPod } from '@johnhenry/browsermesh-pod'

const pod = new InjectedPod({ extensionBridge: chrome.runtime.connect() })
await pod.boot()

console.log(pod.pageContext)    // { url, title, origin, favicon }
console.log(pod.extractText())  // visible page text
```

## Peer Dependency

This package requires `browsermesh-primitives` as a peer dependency for Ed25519 identity generation (`PodIdentity`). Install it alongside:

```bash
npm install @johnhenry/browsermesh-pod @johnhenry/browsermesh-primitives
```

## License

MIT
