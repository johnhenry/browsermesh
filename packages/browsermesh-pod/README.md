# browsermesh-pod

Pod base class for browser execution contexts with Ed25519 identity, BroadcastChannel discovery, and peer messaging.

A Pod is any browser execution context (window, iframe, worker, service worker) that can execute code, receive messages, and be discovered/addressed. This package provides the standalone base class with zero framework dependencies.

Pods automatically generate an Ed25519 cryptographic identity, detect their execution context, discover same-origin peers via BroadcastChannel, and establish roles (autonomous, child, peer).

## Install

```bash
npm install browsermesh-pod browsermesh-primitives
```

`browsermesh-primitives` is a peer dependency (provides Ed25519 identity generation).

## Quick Start

```js
import { Pod } from 'browsermesh-pod'

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
import { installPodRuntime, createRuntime, createClient, createServer } from 'browsermesh-pod'

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

## InjectedPod

Lightweight subclass for Chrome extension injection or bookmarklet use. Adds page text extraction, structured data extraction, and a visual overlay indicator.

```js
import { InjectedPod } from 'browsermesh-pod'

const pod = new InjectedPod({ extensionBridge: chrome.runtime.connect() })
await pod.boot()

console.log(pod.pageContext)    // { url, title, origin, favicon }
console.log(pod.extractText())  // visible page text
```

## Peer Dependency

This package requires `browsermesh-primitives` as a peer dependency for Ed25519 identity generation (`PodIdentity`). Install it alongside:

```bash
npm install browsermesh-pod browsermesh-primitives
```

## License

MIT
