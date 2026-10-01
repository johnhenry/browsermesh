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
- [Running a Pod outside the browser](#running-a-pod-outside-the-browser)
- [Pod host protocol](#pod-host-protocol)
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
| `server` | No `window`, `document`, or worker global scope — plain Node.js, including a Firecracker microVM guest. Note: inside workerd/Cloudflare Workers the global is an instance of `ServiceWorkerGlobalScope`, so an isolate-hosted pod reports `service-worker`, not `server`. See [Running a Pod outside the browser](#running-a-pod-outside-the-browser). |
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

## Running a Pod outside the browser

`Pod` (`src/pod.mjs`) is runtime-agnostic: it imports only `PodIdentity` from
`@johnhenry/browsermesh-primitives` plus its own sibling modules. Everything
browser-specific lives in the pluggable `transport`/`discovery` adapters and
in feature-detected capability flags, not in the core class. This section
spells out exactly what a non-browser host needs to provide, verified
against this package's source (see
[`docs/hosted-pods.md`](../../docs/hosted-pods.md) at the monorepo root for
the full design and how this fits into hosted-pod lanes).

### Exact runtime requirements

A default `pod.boot()` call (no `window`/`document` present, so
`detectPodKind()` returns `'server'`) needs:

| Requirement | Why | Always runs, or conditional? |
| --- | --- | --- |
| `crypto.subtle` — Ed25519 `generateKey` | `PodIdentity.generate()` | Always, unless `opts.identity` is passed in |
| `crypto.subtle` — `exportKey('raw')` + SHA-256 `digest` | `derivePodId()` | Always, as part of `PodIdentity.generate()` |
| `btoa` / `atob` | `encodeBase64url()`/`decodeBase64url()` | Always — every `podId` derivation calls these |
| `setTimeout` | `TransportDiscovery.start()`'s discovery-timeout wait | Whenever a real (non-`Null`) transport/discovery pair is used |
| `TextEncoder`/`TextDecoder`, `structuredClone` | *(not actually used by this package)* | N/A — see note below |

`crypto.subtle.sign`/`verify` are also available on `PodIdentity` but are
**not** called during `boot()` itself — only when application code
explicitly signs or verifies data.

**Note on `TextEncoder`/`TextDecoder` and `structuredClone`:** despite
sometimes being cited as `Pod` runtime requirements, neither is used
anywhere in this package's source. `TextEncoder`/`TextDecoder` appear only
in `browsermesh-primitives`' wire-format module, which `Pod` does not
import; `structuredClone` appears only in a primitives test helper. If your
host environment is missing them, `Pod` itself still works — you'd only hit
a problem if you separately use the primitives wire format or that test
helper. All three (plus `btoa`/`atob`) are present in Node ≥18, browsers,
and `workerd`, so this is unlikely to matter in practice — it's called out
here so the requirement list stays exactly as narrow as the code.

None of this requires `window`, `document`, `navigator`, `indexedDB`,
`fetch`, `WebAssembly`, `RTCPeerConnection`, or `SharedArrayBuffer` — those
are only probed, never required, by `detectCapabilities()`.

### The `TransportAdapter` and `DiscoveryAdapter` contracts

Pass `opts.transport` and `opts.discovery` to `boot()` to run `Pod` anywhere
these two interfaces can be implemented:

```ts
interface TransportAdapter {
  readonly ready: boolean
  open(): Promise<void>
  close(): Promise<void>
  send(msg: object): void                       // no-op before open(), never throws
  onMessage(handler: (msg: object) => void): void
}

interface DiscoveryAdapter {
  start(): Promise<void>
  stop(opts?: { silent?: boolean }): Promise<void>
  onPeerDiscovered(handler: (peer: { podId: string, kind?: string }) => void): void
  onPeerLost(handler: (peer: { podId: string }) => void): void
  onMessage(handler: (msg: object) => void): void   // non-discovery messages pass through
}
```

Every `TransportAdapter` implementation in this package (and any you write)
is expected to satisfy the shared conformance suite in
`test/helpers/transport-conformance.mjs` — see
`test/transport-conformance.test.mjs` for how the three built-in adapters
are wired into it.

### Worked example: `EventEmitterTransport` + `NullDiscovery` in Node

This mirrors the composition a server-side `Pod` subclass would use to run
a pod in plain Node with no browser APIs at all — an in-process
`EventEmitterTransport` shared bus stands in for a real network transport,
and `NullDiscovery` skips the hello/ack handshake since there's nothing to
discover on a bus you fully control yourself:

```js
import { Pod } from '@johnhenry/browsermesh-pod'
import { EventEmitterTransport, NullTransport } from '@johnhenry/browsermesh-pod'
import { NullDiscovery } from '@johnhenry/browsermesh-pod'

// A shared in-process bus standing in for a real network (relay, WebSocket, …)
const bus = EventEmitterTransport.createBus()

class NodePod extends Pod {
  _onMessage(msg) {
    console.log(`[${this.podId}] received`, msg.payload)
  }
}

const alpha = new NodePod()
const beta = new NodePod()

await alpha.boot({
  transport: new EventEmitterTransport(bus),
  discovery: new NullDiscovery(),
})
await beta.boot({
  transport: new EventEmitterTransport(bus),
  discovery: new NullDiscovery(),
})

// NullDiscovery doesn't run the hello/ack protocol, so peers aren't
// auto-discovered — address pods directly once you know their podId:
alpha.send(beta.podId, { text: 'hello from alpha' })
```

Swap `NullDiscovery` for a `TransportDiscovery` wired to the same
`EventEmitterTransport` if you want real hello/ack peer discovery over the
bus instead of addressing pods by a `podId` you already have out of band.
To actually leave the process — reaching a pod hosted in a separate Node
process, a V8 isolate, or a Firecracker microVM guest — swap the transport
for one that crosses a real network boundary (a `WebSocketTransport`
speaking to a relay/signaling server; see `docs/hosted-pods.md` at the
monorepo root for that design). Until such a transport lands, `Pod` running
server-side is confined to one process, same as `EventEmitterTransport`
always has been.

> [!WARNING]
> **`node:vm` and `worker_threads` are NOT security boundaries.** Node's own
> `node:vm` docs say so explicitly, and `worker_threads` share the host
> process's memory space and OS permissions. Use them to pack multiple
> *trusted* pods into one process to save memory — never to run a
> stranger's code. If you need to run code from an untrusted party, that
> belongs in a real isolation boundary: a V8 isolate (`workerd`/Cloudflare
> Workers + Durable Objects) or a Firecracker microVM. See
> `docs/hosted-pods.md`'s "isolate pod" and "microVM pod" lanes for the two
> supported designs.

## Pod host protocol

`src/host-protocol.mjs` is the plain-data half of the **hosted-pods control
surface** ([issue #185](https://github.com/johnhenry/browsermesh/issues/185)):
one lane-agnostic verb set that every way of driving a hosted pod — the
mesh service in `@johnhenry/browsermesh-apps`, `mesh://` routes, `meshctl`
tools, an external CLI, a supervisor — projects.

It lives *here*, not in `browsermesh-apps`, so the two places a hosted pod
actually runs (a Worker / Durable Object, a microVM host agent) can import
the verbs, the podspec validator and the wire shapes without pulling in the
app runtime. Zero dependencies, no browser-only globals, no `node:` imports.

### The verbs

| Verb | Payload | Returns | Notes |
| --- | --- | --- | --- |
| `spawn` | a **podspec** (below) | pod status | `EEXIST` if the name is live |
| `status` | `{name}` | pod status | `ENOENT` if unknown |
| `send` | `{name, to?, payload}` | driver-defined | delivers a message to the pod |
| `exec` | `{name, command, timeoutMs?}` | `{stdout, stderr, code}` | `ELANE` on isolate/browser |
| `snapshot` | `{name}` | pod status | `ELANE` on isolate/browser |
| `restore` | `{name}` | pod status | `ELANE` on isolate/browser |
| `drain` | `{name, cascade?}` | pod status | ends at `gone` |
| `list` | `{}` | pod status[] | every pod the host tracks |

`validateVerbRequest(verb, payload)` returns `{ok: true, value}` with the
payload normalized (`exec`'s `command` is always a `string[]`; `drain`'s
`cascade` is always a boolean) or `{ok: false, errors: string[]}`. A string
`command` becomes a *single-element* argv — it is deliberately not
shell-split; pass `['sh', '-c', '…']` when a shell is really wanted.

Which lane can do what is static, not a runtime surprise — `POD_LANE_VERBS`
and `laneSupports(lane, verb)` say so up front:

| Lane | `spawn` | `status` | `send` | `exec` | `snapshot` | `restore` | `drain` | `list` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `isolate` | ✓ | ✓ | ✓ | `ELANE` | `ELANE` | `ELANE` | ✓ | ✓ |
| `microvm` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `node` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `browser` | ✓ | ✓ | ✓ | `ELANE` | `ELANE` | `ELANE` | ✓ | ✓ |

`POD_LANE`'s strings are identical to `RUNTIME_CLASS` in
`@johnhenry/browsermesh-apps`' `resources.mjs`, so a host's lane is also the
`runtime:<class>` capability the `ResourceScorer` matches on. They are
duplicated rather than imported on purpose (this package must stay
importable from a Worker); if one gains a lane, add it to both.

### The podspec

```js
import { validatePodSpec } from '@johnhenry/browsermesh-pod'

const { ok, value, errors } = validatePodSpec({
  name: 'greeter',                                 // [A-Za-z0-9][A-Za-z0-9._-]{0,63}
  lane: 'isolate',                                 // optional — defaulted from run.kind
  run: { kind: 'skill', ref: 'greeter', entry: 'main.mjs', input: { seed: 1 } },
  limits: { vcpus: 1, memMib: 128, timeoutMs: 30_000 },
  caps: ['net', 'mesh'],                           // KERNEL_CAP strings
  env: { LOG_LEVEL: 'info' },
  budget: { credits: 10, currency: 'bmc' },
  restart: { policy: 'on-failure', maxRestarts: 3, backoffMs: 500 },
  labels: { team: 'core' },
})
```

Only two defaults are ever applied: `lane` (`isolate` for a `skill`/`module`
run, `microvm` for `command`/`rootfs`) and `restart.policy` (`'never'`).
Optional sections that were absent stay absent, so a driver can tell "no
limits asked for" from "limits asked for, all defaults". **Unknown keys are
an error**, at every level — a mistyped `limits.memMB` that silently did
nothing would be a quota bug nobody notices until the bill.

### Lifecycle

`POD_LIFECYCLE` matches `docs/hosted-pods.md` §5.3 and adds a terminal
`gone`; `POD_LIFECYCLE_TRANSITIONS` is the frozen `from -> to[]` map and
`canTransition(from, to)` the predicate drivers enforce with:

```
cold → booting → registered ⇄ serving
                 registered → paused → snapshotted → restoring → registered
                 registered → draining → cold | gone
```

Every non-terminal state may also jump straight to `gone` — a host losing
its VMM or isolate is not a graceful drain but still has to be reportable.

### Wire messages

`createHostRequest(verb, payload, {requestId?})`,
`createHostResponse(requestId, {ok, result?, error?})` and
`createHostEvent(kind, data)` build the three JSON-safe envelopes
(`pod-host:request` / `pod-host:response` / `pod-host:event`). Event kinds
are `lifecycle`, `log` and `exit`. Errors travel as `{code, message}` with
`code` one of `POD_HOST_ERROR`: `EACCES`, `ENOENT`, `EEXIST`, `EINVAL`,
`ENOTSUP`, `ELANE`, `ETIMEDOUT`, `EBUSY`. `ELANE` means "this lane
structurally cannot"; `ENOTSUP` means "this driver did not implement an
otherwise lane-compatible verb".

### The `PodHostDriver` interface

A driver is **any object** with these members — a typedef, not a base class,
so a Worker, a Firecracker host agent and an in-memory fake can all be one
without inheriting anything:

```js
{
  lane,                                  // a POD_LANE value
  capabilities(),                        // -> { verbs: string[] }
  spawn(spec), status(name), send(name, msg),
  exec(name, argv, opts), snapshot(name), restore(name),
  drain(name, opts), list(),             // all Promise-returning
  onEvent(fn),                           // optional; returns unsubscribe
}
```

A verb the driver cannot serve must reject with a `PodHostDriverError`
carrying `ELANE` or `ENOTSUP`; `createUnsupportedDriverMethod(verb, lane)`
builds exactly such a method so a partial driver still has all eight.

`InMemoryPodHostDriver` is the complete reference driver: a `Map` of fake
pods running the real state machine, every verb implemented, an injectable
`exec` (default: echo the argv), and `onEvent()` fan-out. Tests, examples
and every later control surface use it when they need a host that behaves
correctly without a workerd process or a KVM box behind it.

```js
import { InMemoryPodHostDriver } from '@johnhenry/browsermesh-pod'

const driver = new InMemoryPodHostDriver({ lane: 'node' })
driver.onEvent((event) => console.log(event.kind, event.data))

await driver.spawn({ name: 'alpha', lane: 'node', run: { kind: 'command', ref: '/bin/echo' } })
await driver.exec('alpha', ['echo', 'hi'])   // { stdout: 'echo hi', stderr: '', code: 0 }
await driver.snapshot('alpha')               // -> paused -> snapshotted
await driver.restore('alpha')                // -> restoring -> registered
await driver.drain('alpha')                  // -> draining -> gone
```

The gated, audited mesh service that speaks this protocol over a `PeerNode`
is `createPodHostService()` in `@johnhenry/browsermesh-apps` — see that
package's "Pod host service" README section.

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
