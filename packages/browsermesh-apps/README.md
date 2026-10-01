# browsermesh-apps

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-apps.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-apps)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-apps.svg)](LICENSE)

Application layer for BrowserMesh: marketplace, chat, payments, compute orchestration, and agent tools.

## Contents

- [Provenance](#provenance)
- [Modules](#modules)
- [GPU compute](#gpu-compute)
- [Install](#install)
- [Usage](#usage)
- [Connecting a real mesh node: `createMeshNode()`](#connecting-a-real-mesh-node-createmeshnode)
  - [TURN server configuration](#turn-server-configuration)
- [Sharing a `VirtualNetwork` with specific peers: mesh relay](#sharing-a-virtualnetwork-with-specific-peers-mesh-relay)
- [CloudStorage bucket authorization and key distribution](#cloudstorage-bucket-authorization-and-key-distribution)
- [CloudStorage: the ergonomic SDK](#cloudstorage-the-ergonomic-sdk)
- [Putting it all together: sync + kernel-gated mesh + relay on one connection](#putting-it-all-together-sync--kernel-gated-mesh--relay-on-one-connection)
- [`fetch()`/`WebSocket`-shaped mesh access: `browserMeshFetch` and `BrowserMeshWebSocket`](#fetchwebsocket-shaped-mesh-access-browsermeshfetch-and-browsermeshwebsocket)
  - [`browserMeshFetch`](#browsermeshfetch)
  - [`BrowserMeshWebSocket`](#browsermeshwebsocket)
- [LLM tool-calling: `BrowserToolRegistry` and `createAgentRuntime`](#llm-tool-calling-browsertoolregistry-and-createagentruntime)
- [Runtime classes and placement lanes](#runtime-classes-and-placement-lanes)
- [Pod host service: spawning and controlling hosted pods](#pod-host-service-spawning-and-controlling-hosted-pods)
- [License](#license)

## Provenance

Extracted from the private `clawser` monorepo (previously `packages/browsermesh-apps`), where it was manually published to npm, unscoped, as `browsermesh-apps@0.1.0` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.


## Modules

| Module | Key Exports |
|--------|-------------|
| apps | `AppRegistry`, `AppStore`, `AppRPC`, `AppEventBus` |
| marketplace | `Marketplace`, `MarketplaceIndex`, `ServiceListing` |
| chat | `MeshChat`, `ChatRoom`, `ChatMessage` |
| payments | `PaymentChannel`, `EscrowManager`, `CreditLedger`, `PaymentRouter` |
| quotas | `QuotaManager`, `QuotaEnforcer` |
| resources | `ResourceRegistry`, `ComputeRequest`, `ResourceScorer`, `JobQueue` |
| gpu | `TrainingOrchestrator`, `GpuProbe`, `GradientAggregator` |
| scheduler | `MeshScheduler`, `TaskQueue` |
| consensus | `ConsensusManager`, `Proposal`, `Ballot` |
| orchestrator | `MeshOrchestrator` + meshctl BrowserTool subclasses |
| mesh-orchestrator | `createOrchestratorService` (`MeshService` wrapper: real, gated wire dispatch for `execOnPod`/`deploySkill`/`drainPod`, ungated local aggregation for `listPods`/`getPodStatus`/`topPods`) |
| compat | `BrowserTool`, `BrowserToolRegistry` (base class + registry an LLM-drivable agent loop dispatches tool calls through) |
| agent-runtime | `createAgentRuntime` (the LLM tool-calling dispatch loop: bring-your-own `llmFn`, real registry-backed tool execution) |
| mesh-orchestrator-tools | `registerOrchestratorTools`, `createOrchestratorToolRegistry` (wires the 13 real `Meshctl*Tool`s into a `BrowserToolRegistry` against a real, attached `MeshOrchestrator`) |
| audit | `AuditChain`, `AuditStore`, `detectFork`, `buildMerkleRoot` |
| visualizations | `TopologyLayout`, `TrustGraphLayout`, `TrustHeatmap` |
| devtools | `MeshInspector`, `MeshInspectTool` |
| tools | `registerMeshTools` + stream/file/DHT/GPU/IoT BrowserTool subclasses |
| peer-agent | `AgentHost`, `AgentClient`, `bridgePeerAgent` |
| peer-agent-swarm | `AgentSwarmCoordinator` |
| peer-chat | `PeerChat` |
| peer-compute | `FederatedCompute`, `FederatedJob` |
| peer-encrypted-store | `EncryptedBlobStore` |
| peer-escrow | `EscrowContract`, `EscrowManager` |
| peer-files | `FileHost`, `FileClient` |
| peer-health | `HealthMonitor`, `AutoMigrator` |
| peer-ipfs | `IPFSStore` |
| peer-node | `PeerNode` |
| peer-payments | `CreditLedger`, `WebLNProvider` |
| peer-registry | `PeerRegistry` |
| peer-routing | `MeshRouter`, `ServerSharing` |
| peer-services | `ServiceAdvertiser`, `ServiceBrowser` |
| peer-terminal | `TerminalHost`, `TerminalClient` |
| peer-timestamp | `TimestampAuthority`, `TimestampProof` |
| peer-torrent | `TorrentManager` |
| peer-verification | `VerificationQuorum`, `Attestation` |
| marketplace-ui | `SkillMarketplace` |
| mesh-relay-host | `MeshRelayHost` |
| mesh-relay-backend | `createMeshRelayBackend` |
| mesh-service | `attachService`, `MeshService` (attach convention) |
| cloud-storage-backend | `createCloudStorageBackend` |
| grant-log | `GrantLog`, `createGrantLogService` |
| key-distribution | `createKeyDistributionService` |
| manifest-sync | `createManifestSyncService` |
| chunk-replication | `createChunkReplicationService` |
| cloud-storage | `CloudStorage`, `CloudStorageNotFoundError` (the ergonomic S3-like SDK) |

## GPU compute

`GradientAggregator.aggregateGPU(device)` runs a real WGSL compute shader
(`src/gpu-kernel.mjs`) to aggregate submitted gradients when given a usable
`GPUDevice` -- one thread per output parameter index, covering both
`aggregate()`'s aggregation strategies (weighted `federated_avg`, unweighted
`sync_allreduce`/`async_parameter_server`) via a uniform flag. The compiled
shader module/pipeline is cached per-device.

It is entirely optional and degrades safely: called with no device, or a
device whose `limits.maxStorageBufferBindingSize` is too small for the
flattened gradient buffer, it falls back to the existing synchronous
`aggregate()` CPU implementation (wrapped in a resolved Promise). That
fallback is exercised unconditionally in `test/gpu.test.mjs` and needs no
GPU -- it is what keeps this package's normal `npm test` green everywhere,
including CI.

`TrainingOrchestrator` accepts an optional `{ gpuDevice }` constructor
option; when supplied, `handleGradientPush()` uses it once a job's
aggregator has every shard's gradient, and stores the result on the job
record (retrievable via `getJobResult(jobId)`, and included in
`getJobStatus()`'s return).

Coverage against a *real* WebGPU implementation (not just the fallback
branch) lives in `test/gpu-real-webgpu/kernel.test.mjs`, gated behind the
optional `webgpu` devDependency, run via `npm run test:real-gpu`
(`REQUIRE_WEBGPU=1 npm run test:real-gpu` to make an absent/non-functional
binding a hard failure rather than a silent skip -- see that file for the
full rationale, which mirrors `browsermesh-transport`'s `test:real-peer`
pattern).

**Headless CI finding**: this tier is deliberately **not** wired into CI
(see `.github/workflows/ci.yml`) -- run it locally/manually via
`npm run test:real-gpu`. Getting a real adapter/device at all took work: on
a bare `ubuntu-latest`-equivalent image with no GPU hardware,
`requestAdapter()` returns `null` -- Dawn's Vulkan backend has no ICD to
talk to at all (`libvulkan.so.1` isn't installed by default, so there's
nothing to even attempt a software fallback through). Installing
`libvulkan1` and `mesa-vulkan-drivers` (Mesa's `llvmpipe`/lavapipe software
rasterizer) does make a real adapter/device available headlessly, and the
shader's actual compute output (both the weighted and unweighted branches)
was verified correct against it, cross-checked against the CPU
`aggregate()` path -- confirmed on a local emulated approximation of that
environment.

But wiring that into an actual CI step and running it against this repo's
real GitHub-hosted `ubuntu-latest` runner surfaced a second problem the
local approximation didn't: a deterministic **native crash** inside the
`webgpu` binding itself, partway through the very first test, right as
`GPUBuffer.mapAsync()`'s cross-thread completion callback fires:

```
Fatal glibc error: pthread_mutex_lock.c:94 (___pthread_mutex_lock): assertion failed: mutex->__data.__owner == 0
```

That's a threading bug in `dawn.node`'s own native code (a pthread mutex
locked from the wrong owning thread), not in this package's WGSL or JS --
and it didn't reproduce locally, most likely because the local
approximation ran the same Ubuntu image under QEMU emulation, which serializes/
slows execution enough to mask a real-hardware timing race. There is no
JS-level try/catch that can turn a native process crash into a clean test
failure, let alone a graceful skip, so this tier cannot be safely made a
required CI check today. It stays a real, valuable, but local-only/manual
verification path until either the upstream binding fixes this, or a
different Node WebGPU binding is adopted.

## Install

```bash
npm install @johnhenry/browsermesh-apps @johnhenry/browsermesh-primitives @johnhenry/browsermesh-core @johnhenry/browsermesh-transport @johnhenry/browsermesh-sync @johnhenry/browsermesh-discovery
```

## Usage

```js
import { MeshChat, AppRegistry, MeshOrchestrator } from '@johnhenry/browsermesh-apps';
```

## Connecting a real mesh node: `createMeshNode()`

`mesh-bootstrap.mjs`'s `createMeshNode(options)` is the composition root that
wires a real Ed25519 identity, discovery, and a real WebRTC transport
negotiator into a booted `PeerNode`. A minimal call needs only an injectable
signaling transport (see `signaling.mjs`) to relay WebRTC offer/answer/ICE
messages between peers:

```js
import { createMeshNode } from '@johnhenry/browsermesh-apps';

const node = await createMeshNode({
  signalingTransport, // a {send(msg), onMessage(cb)} bus -- see signaling.mjs
});
```

### TURN server configuration

By default, `createMeshNode()` gathers **no ICE servers at all** (no STUN,
no TURN) -- host candidates only, which is enough for peers on the same LAN
and discloses nothing to a third party. That's fine for typical NAT, but
peers behind symmetric or restrictive NATs need a STUN and/or TURN server to
connect at all.

Pass standard `RTCIceServer`-shaped entries via `options.iceServers`:

```js
import { createMeshNode } from '@johnhenry/browsermesh-apps';
import { PUBLIC_STUN_SERVERS } from '@johnhenry/browsermesh-transport';

const node = await createMeshNode({
  signalingTransport,
  iceServers: [
    ...PUBLIC_STUN_SERVERS, // opt-in public STUN (see browsermesh-transport's webrtc.mjs)
    { urls: 'turn:turn.example.com:3478', username: 'alice', credential: 's3cr3t' },
  ],
});
```

`iceServers` is merged with `DEFAULT_ICE_SERVERS` via
`@johnhenry/browsermesh-transport`'s `mergeIceServers()` -- the same
extension point `webrtc.mjs` already exposes, reused here rather than
reimplemented:

- Omit the option, or pass `undefined`/`null`, to keep the default (no ICE
  servers).
- Pass a non-empty array (TURN and/or STUN entries) to **add** them
  alongside the defaults; malformed entries (missing `urls`) are silently
  dropped rather than passed through to `RTCPeerConnection`.
- Pass an explicit `iceServers: []` to mean "no ICE servers at all" --
  honoured as given, never replaced by the defaults. This is what this
  package's own `test/real-peer/mesh-bootstrap.test.mjs` uses for a
  hermetic, loopback-only connection in CI.

This reaches the `WebRTCMeshManager` that `createMeshNode()` attaches to the
returned node as `node.meshManager`, and from there every
`WebRTCPeerConnection` it creates.

## Sharing a `VirtualNetwork` with specific peers: mesh relay

Real-world scenario: your peer already reaches a real local service (e.g. an
S3-compatible emulator, via `@johnhenry/browsermesh-netway`'s `GatewayBackend`
tunneling real TCP through a local `wsh` server) on its own `VirtualNetwork`.
`MeshRelayHost`/`MeshRelayBackend` let you share *that specific access* with
specific, authorized mesh peers over the real WebRTC connection you already
have -- gated per-peer, per-service, per-action, with zero new authorization
machinery.

On the host side (the peer whose `VirtualNetwork` is being shared), either
pass `{ enableRelayHost: true, relayHostNetwork }` to `createMeshNode()`:

```js
import { createMeshNode } from '@johnhenry/browsermesh-apps';

const alice = await createMeshNode({
  signalingTransport,
  enableRelayHost: true,
  relayHostNetwork: aliceNetwork, // alice's own VirtualNetwork
  relayHostServices: { 's3-local': 'tcp://127.0.0.1:9000' },
});
// alice.relayHost.exposeService(name, targetAddress) / .hideService(name)
// are also available for exposing services after boot.
```

or construct a `MeshRelayHost` directly against any booted `PeerNode`. Then
grant specific peers access to specific services via `PeerRegistry`'s
existing capability API -- no new scope grammar, just
`mesh-relay:<service>:connect` (wildcards like `mesh-relay:*:connect` work
too, since `MeshACL`'s scope matching already supports them):

```js
alice.registry.grantCapabilities(bob.podId, ['mesh-relay:s3-local:connect']);
// ...later, to cut Bob off:
alice.registry.revokeCapabilities(bob.podId, ['mesh-relay:s3-local:connect']);
```

On the client side (the peer being granted access), `createMeshRelayBackend()`
builds a `browsermesh-netway` `Backend` -- register it on your own `VirtualNetwork`
under any scheme you like, and connect through the normal API, treating the
service name as the "host":

```js
import { createMeshRelayBackend } from '@johnhenry/browsermesh-apps';
import { VirtualNetwork } from '@johnhenry/browsermesh-netway';

const bobNetwork = new VirtualNetwork();
bobNetwork.addBackend('via-alice', createMeshRelayBackend({ node: bob, relayPeerPubKey: alice.podId }));

const socket = await bobNetwork.connect('via-alice://s3-local'); // refused (ConnectionRefusedError) until granted
```

TCP-only for now (`listen()`/`bindDatagram()` on `MeshRelayBackend` are the
inherited `Backend` "not implemented" throws). See
`examples/06-mesh-relay.mjs` for a full runnable walkthrough (in-process
simulated mesh connection) and
`test/real-peer/mesh-relay.test.mjs` for the real-WebRTC, real-TCP proof.

## CloudStorage bucket authorization and key distribution

`grant-log.mjs`'s `GrantLog` (`createGrantLogService()`) is a replicated,
Ed25519-signed append-log of `grant`/`revoke` records per bucket resource
(`s3:<bucketId>`), used to propagate a CloudStorage bucket's access-control
decisions to every peer independently enforcing them (each peer replays the
merged log into its own, unmodified `PeerRegistry.grantCapabilities()`/
`revokeCapabilities()`).

`key-distribution.mjs`'s `createKeyDistributionService()` builds on top of
`GrantLog`'s change notifications: whenever a peer's merged, effective grants
on a bucket go from none to some, a peer that already holds that bucket's
AES-256-GCM key (`cloud-storage-backend.mjs`'s `CloudStorageBackend`) sends it
to the newly-granted peer over a dedicated, signed, point-to-point channel,
encrypted to a companion X25519 key the recipient generates and advertises
for exactly this purpose (Ed25519 identity keys can't do ECDH directly, and
this repo intentionally has no Ed25519-to-X25519 conversion utility -- see
that file's own doc comment for the full writeup, including why the wrap/
unwrap step itself reuses `browsermesh-core`'s existing `wrapKeyForMember()`/
`unwrapKeyForMember()` rather than adding a new crypto primitive).

**Permanent limitation, not a bug to fix later:** revoking a peer's grant
(via `GrantLog.revoke()`) stops *future* key distribution and *future* chunk
replication to that peer, but cannot retroactively erase a key -- or any
plaintext already decrypted with it -- already delivered to that peer before
the revoke. A bucket's AES key is never rotated on revoke anywhere in this
plan. Any since-revoked peer that retained the key (or any chunk ciphertext
plus the key) can still decrypt that data offline, forever. This is a
fundamental property of any scheme that hands symmetric key material to
multiple independent parties -- the same is true of, say, a downloaded S3
object whose bucket policy changes afterward -- not something a future phase
of this plan is expected to close.

## CloudStorage: the ergonomic SDK

`cloud-storage.mjs`'s `CloudStorage` class is the actual developer-facing
surface the whole plan above was building toward:

```js
import { CloudStorage as s3 } from '@johnhenry/browsermesh-apps'
const store = new s3({ bucket: 'my-bucket', node: peerNode })
await store.becomeAdmin()                      // bootstrap: this peer owns the bucket
await store.grant(otherPubKey, ['read', 'write'])
const { durability, replicatedTo } = await store.put('key', data)
const bytes = await store.get('key')            // falls back to a remote peer request if not held locally
```

It composes `CloudStorageBackend` (local, durable, encrypted-at-rest reads/
writes) with `createGrantLogService()`, `createKeyDistributionService()`,
`createManifestSyncService()`, and `createChunkReplicationService()` — all
four attached via `attachService()` with no `network` required — behind
`put`/`get`/`delete`/`list` plus bucket-admin methods
(`becomeAdmin`/`grant`/`revoke`/`designateReplica`/`effectiveGrants`). See
`src/cloud-storage.mjs`'s own module doc comment for the full design
writeup, including several real gaps the plan's original brief left open and
exactly how each was resolved.

`examples/09-cloud-storage.mjs` is the full story end to end, runnable with
plain `node`. `test/real-peer/cloud-storage.test.mjs` proves the identical
composition over an actual WebRTC connection. **New to building a
mesh-native service yourself?** `docs/building-mesh-services.md` is the
reusable guide this phase (K, the plan's capstone) produced — the
`MeshService` attach contract, the control/data-plane transport split, the
CRDT-manifest-plus-content-addressed-chunk pattern, the signed
GrantLog pattern, and the key-distribution pattern, each with pointers to
the real code, written so the *next* mesh-native service doesn't have to
rediscover these same design questions from scratch.

## Putting it all together: sync + kernel-gated mesh + relay on one connection

Every composition layer above (`enableSync`, a `Kernel` wired via
`createMeshKernel({ peerNode })`, and `enableRelayHost`) attaches to the
*same* `PeerNode` independently -- nothing about wiring one requires or
excludes the others, and each dispatches on `PeerNode`'s shared
`onIncomingData()` bus, filtering by its own `envelope.type` (`'mesh-sync'`,
`'mesh-relay'`; the kernel's `caps.mesh` view is unfiltered -- see below).

`test/real-peer/full-pipeline.test.mjs` proves all three actually compose on
one live, real WebRTC connection: CRDT sync converges, a kernel tenant's
`caps.mesh.send()`/`onReceive()` moves real bytes, and a mesh-relay round
trip completes, all interleaved on the same `PeerNode` pair, with no
envelope-type collisions or dispatch corruption between them.
`examples/07-full-mesh-pipeline.mjs` is the same story narrated for a human
reader (in-process simulated connection, like `06`).

One property worth knowing if you wire a kernel mesh capability alongside
sync/relay: `Kernel#meshFor()`'s `onReceive` is **not** scoped by
`envelope.type` the way `MeshSyncBinding`/`MeshRelayHost` are -- a kernel
tenant's `caps.mesh.onReceive` callback sees every inbound payload on the
connection, including `mesh-sync`/`mesh-relay`-typed envelopes not meant for
it (harmless -- those envelopes are just plain objects with a `.type` field
tenant code can filter on itself if it cares, but worth knowing rather than
assuming the view is pre-filtered).

## `fetch()`/`WebSocket`-shaped mesh access: `browserMeshFetch` and `BrowserMeshWebSocket`

Two web-standard-API-shaped wrappers over a mesh connection, so existing
code that already expects `fetch(url) -> Response` or `new WebSocket(url)`
can reach a mesh-addressable pod (`mesh://podId/path`) without learning
`PeerNode`'s raw `sendTo()`/`onIncomingData()` API. Both are built on
`mesh-rpc.mjs`'s `createMeshRpcService()`, a general-purpose request/response
transport over the same `ctx.sendTo()`/`ctx.onIncomingData()` convention
every `MeshService` in this family uses (attach it via
`attachService(peerNode, network, createMeshRpcService({ onRequest }))`, or
pass it through `createMeshNode({ services: [...] })`).

**Authorization boundary, stated explicitly because it's easy to miss:**
neither transport checks `registry.checkAccess()` against any fixed
resource/scope -- a general-purpose RPC/duplex channel has no fixed resource
to check a scope against. Deciding what `{method, path}` combinations (for
`browserMeshFetch`) or which `(fromPubKey, path)` connections (for
`BrowserMeshWebSocket`) are allowed is the *responding pod's own*
`onRequest`/`onConnection` handler's job, the same way a real HTTP server's
application code owns its own authorization, not its TCP/TLS transport
layer.

### `browserMeshFetch`

`createBrowserMeshFetch(meshRpcApi) -> (url, init) => Promise<Response>` binds
once to a live `mesh-rpc` service's `api` (the `{ request }` object
`attachService()` returns as `.api`) and hands back a plain function whose
call signature matches real `fetch(url, init)` exactly -- so it can be
dropped in anywhere something expects "a fetch-shaped function", with no
adapter:

```js
import { attachService, createMeshRpcService, createBrowserMeshFetch } from '@johnhenry/browsermesh-apps'

// on the peer being called:
attachService(bobNode, undefined, createMeshRpcService({
  onRequest: async ({ method, path, body }) => {
    if (method === 'GET' && path === '/status') return { status: 200, body: { ok: true } }
    return { status: 404, body: { error: 'not found' } }
  },
}))

// on the calling peer:
const { api } = attachService(aliceNode, undefined, createMeshRpcService({}))
const browserMeshFetch = createBrowserMeshFetch(api)

const res = await browserMeshFetch('mesh://bob-pod-id/status')
const data = await res.json() // { ok: true }
```

Error-vs-reject semantics deliberately match real `fetch()`, not a Service
Worker interceptor's "always resolve some Response" convention: a malformed
`mesh://`/`*.mesh.local` URL throws a `TypeError` *synchronously*, before any
Promise exists; a responding pod's `onRequest` throwing or returning a
non-2xx `status` still resolves a genuine `Response` (status/headers/body
shaped from whatever it returned); only a transport-level failure -- no
matching response within the timeout, or the peer being unreachable --
*rejects* the returned promise, matching what a real network-level `fetch()`
failure means.

### `BrowserMeshWebSocket`

A class implementing the standard `WebSocket` *instance* surface
(`readyState`, `onopen`/`onmessage`/`onerror`/`onclose`,
`addEventListener`/`removeEventListener`, `send()`, `close()`) over a
persistent mesh envelope channel. **One real, deliberate deviation from the
standard constructor:** `new WebSocket(url)` needs no extra arguments
because a browser's networking stack is an ambient, process-wide resource --
there is no mesh equivalent, so `new BrowserMeshWebSocket(url, opts)`
requires `opts.peerNode` (anything exposing `podId`, `sendTo()`,
`onIncomingData()` -- a real `PeerNode` satisfies this). Everything else
matches the standard instance shape as closely as this transport allows.

```js
import { BrowserMeshWebSocket, attachService, createMeshWebSocketService } from '@johnhenry/browsermesh-apps'

// on the peer accepting connections -- the ONLY side that needs a MeshService
// attached; a client-role BrowserMeshWebSocket subscribes directly to its
// own peerNode and needs nothing pre-attached:
attachService(bobNode, undefined, createMeshWebSocketService({
  onConnection: (fromPubKey, path) => path === '/chat', // accept/reject policy lives here
  onIncomingConnection: (session) => {
    session.onmessage = (event) => session.send(`echo: ${event.data}`)
  },
}))

// on the connecting peer:
const socket = new BrowserMeshWebSocket('mesh://bob-pod-id/chat', { peerNode: aliceNode })
socket.onopen = () => socket.send('hello')
socket.onmessage = (event) => console.log(event.data) // 'echo: hello'
```

The accept/reject handshake is `createMeshWebSocketService({ onConnection })`'s
job entirely: `onConnection(fromPubKey, path) -> boolean|Promise<boolean>`
decides per inbound connection attempt. No `onConnection` registered means
every inbound connection is rejected (the safe default -- an "open door" is a
worse default than an RPC transport's "not implemented" 501). A rejected
attempt fires the connecting side's `onerror` then `onclose` with code
`4403`; a connection that never gets a response within the open timeout
(10s default) closes with code `1006`, mirroring real `WebSocket`'s own
abnormal-closure code. `send()` throws `InvalidStateError` both before OPEN
*and* after CLOSE -- the latter a deliberate deviation from the WHATWG spec
(which silently drops a post-close `send()`), judged a worse default for
mesh code than a loud, discoverable throw. `close()` is a one-directional
notification, not a two-phase closing handshake -- there's no TCP-level
half-open state to model over a persistent mesh envelope channel. See
`src/mesh-websocket.mjs`'s module doc comment for the full wire-protocol and
binary-encoding (base64-over-JSON) writeup.

`examples/08-mesh-fetch-websocket.mjs` runs both APIs together end to end
(request/response, and a duplex exchange including both the accept and
reject halves of the handshake) over a simulated in-process connection.

**Considered, deferred:** extending this same "web-standard-API-shaped
wrapper" treatment to `WebTransport`/`RTCDataChannel` was evaluated and
deliberately not scoped here -- see `browsermesh-fetch-websocket.md`'s own
"Considered, deferred" section for the reasoning (mostly: avoid adding more
unconsumed wrapper surface before these two have a real caller).

## LLM tool-calling: `BrowserToolRegistry` and `createAgentRuntime`

A second, deliberately different composition pattern from `MeshService`:
where `MeshService`/`attachService()` (above) is "how a capability attaches
to a `PeerNode`," `BrowserTool`/`BrowserToolRegistry`/`createAgentRuntime`
is "how you expose local OR mesh-backed capabilities to an LLM-driven agent
loop." `compat.mjs`'s `BrowserToolRegistry` holds any number of `BrowserTool`
instances (`register`/`get`/`list`/`listSpecs`/`unregister`); `agent-runtime.mjs`'s
`createAgentRuntime({registry, llmFn})` is the actual conversation loop —
**browsermesh never calls a real LLM API itself** (no Anthropic/OpenAI SDK
dependency anywhere in this family); `llmFn(messages, toolSpecs) ->
{content?, toolCalls?}` is a required, caller-supplied callback, matching
`mesh-compute.mjs`'s `executeFn`/`mesh-agent-swarm.mjs`'s `agentProxy`
"bring your own X" precedent.

`mesh-orchestrator-tools.mjs`'s `registerOrchestratorTools()` is the worked
example of wiring a *mesh-backed* capability into this pattern: it
constructs `orchestrator.mjs`'s 13 real `Meshctl*Tool`s
(`meshctl_pods`/`meshctl_status`/`meshctl_exec`/`meshctl_deploy`/
`meshctl_top`/`meshctl_compute`/`meshctl_expose`/`meshctl_drain`, plus issue
#185 §8a item 4's hosted-pods control surface five —
`meshctl_spawn`/`meshctl_snapshot`/`meshctl_restore`/`meshctl_hosted_pods`/
`meshctl_hosts`) against a real, attached `mesh-orchestrator.mjs` service,
so an LLM-requested `meshctl_exec` tool call really dispatches through that
service's `checkAccess()`-gated wire protocol to a real remote peer.
`createMeshNode({enableAgentRuntime: true, enableOrchestrator: true})` wires
all of this for you, returning `node.toolRegistry` pre-populated and ready
to drive `createAgentRuntime({registry: node.toolRegistry, llmFn})`.

`examples/11-agent-tool-calling.mjs` runs the original eight end to end over
two real `createMeshNode()` peers, with a deterministic test `llmFn`. See
`docs/building-mesh-services.md`'s own "`BrowserTool`/`BrowserToolRegistry`/
agent runtime" section for the full design writeup, including two real bugs
found while building it and the recommended DI pattern for new tools going
forward.

### `meshctl_*` tools for hosted pods (issue #185 §8a item 4)

The five hosted-pods tools project `pod-host-service.mjs`'s eight-verb
control surface (see "Pod host service" below) into the same
`BrowserTool` shape, each calling straight through to `MeshOrchestrator`'s
own `spawnPod`/`snapshotPod`/`restorePod`/`listHostedPods`/`listPodHosts`
methods — which already dispatch over `pod-host-service.mjs`'s own mesh
protocol and are already gated by the target HOST's own
`checkAccess()`, independently of `mesh-orchestrator.mjs`'s
`RISKY_ACTIONS` gate that `meshctl_exec`/`meshctl_deploy`/`meshctl_drain`
use:

| Tool | Args | Calls |
| --- | --- | --- |
| `meshctl_spawn` | `{host, name, lane?, run, limits?, caps?, env?, budget?, restart?}` | `spawnPod()` |
| `meshctl_snapshot` | `{host, name}` | `snapshotPod()` |
| `meshctl_restore` | `{host, name}` | `restorePod()` |
| `meshctl_hosted_pods` | `{host}` | `listHostedPods()` |
| `meshctl_hosts` | `{}` | `listPodHosts()` |

**Auto host selection** (`meshctl_spawn` with `host: 'auto'`, or omitted):
the orchestrator "proposes, the host accepts" — it picks exactly one host
and never silently retries a different one after a refusal (an `EACCES`,
or any other `PodHostDriverError`, is reported as-is). Selection prefers
`listComputeCandidates()` (the same descriptor list `meshctl_compute`
reads), narrowed to hosts advertising `runtime:<lane>` and preferring one
with `availability: 'online'`. Because an ISOLATE-lane host has no `exec`
by lane definition, it never produces a compute descriptor at all (see
"Known limitation" below) — so for `isolate`/`browser` lanes, selection
falls back to `listPodHosts()`, which reads the same runtime-registry peers
directly, without that filter. `MeshOrchestrator#listPodHosts()` is new
read-only bookkeeping this item adds: runtime-registry peers carrying a
`metadata.podHost` entry (i.e. anything projected through
`podHostRuntimePeer()`), returned as `{podId, lane, verbs, runtimeClasses,
shellBackend, resource, capabilities, hostedBy}`.

**Error mapping**: each tool's `error` field turns a `PodHostDriverError`
code into a lane-aware message rather than the raw errno-shaped code —
`ELANE` on `snapshot`/`restore` against an isolate host reads "isolate
pods cannot snapshot/restore; Durable Object hibernation is automatic, not
a verb you drive" (the same mapping the docs/hosted-pods.md §8a lane table
documents), `EACCES` names the host and the verb that was denied, and so
on for `ENOENT`/`EEXIST`/`ENOTSUP`/`ETIMEDOUT`/`EBUSY`.

**The `meshctl` text-command grammar** (`registerMeshctlBuiltins()`) grew
five subcommands matching the new tools one-for-one, usable from any shell
wired to `MeshOrchestrator`:

```
meshctl spawn <host|auto> <name> --lane <lane> --kind <kind> --ref <ref> [--entry <entry>]
meshctl snapshot <host> <name>
meshctl restore <host> <name>
meshctl hosted <host>
meshctl hosts
```

`examples/15-agent-spawns-hosted-pod.mjs` runs the whole story end to end:
a deterministic `llmFn` calls `meshctl_hosts`, then `meshctl_spawn` with
`host: 'auto'`, then `meshctl_hosted_pods`, `meshctl_snapshot`,
`meshctl_restore`, and finally the pre-existing `meshctl_drain` to drain
the host pod itself — composing the five new tools with the original
eight.

## Runtime classes and placement lanes

[Issue #185](https://github.com/johnhenry/browsermesh/issues/185) ("Hosted
pods") proposes running `Pod` outside the browser, on a host someone else
operates, in one of two isolation lanes that the orchestrator places work
across. This package's WP4 slice wires the *vocabulary* and the
`ResourceScorer`/`execOnPod()` placement logic those lanes need; it does
**not** implement the placement RPC itself (spawning or restoring a hosted
pod) -- that is issue #185's WP2 (isolate pod host) and WP3 (microVM pod
host), separate deliverables.

`resources.mjs` exports two frozen constants naming the lanes:

| `RUNTIME_CLASS` | Meaning | Boundary | Good for |
| --- | --- | --- | --- |
| `'browser'` | A tab/iframe/worker pod the user owns | n/a (same trust domain) | everything today's mesh already does |
| `'node'` | A `ServerPod`-style Node process | OS process | shell, filesystem, native modules |
| `'isolate'` | A V8 isolate (workerd / Durable Object) | Language-level (V8) | JS/Wasm skills, agents, CRDT replicas |
| `'microvm'` | A Firecracker microVM running `ServerPod` | Hardware (KVM) | `execOnPod` shell commands, native binaries |

`ISOLATION` names the lane a `ComputeRequest` can require:
`'any'` (default), `'isolate'`, or `'microvm'`.

A `ResourceDescriptor` advertises which lanes it supports as
`runtime:<class>` capability strings (e.g. `'runtime:isolate'`), the same
convention `preferRuntimeClass` already used for
`runtime:<preferRuntimeClass>`. `runtimePeerToComputeDescriptor()` in
`orchestrator.mjs` derives these from a runtime-registry peer's
`metadata.runtimeClasses`, and also copies `metadata.hostedBy` onto the
descriptor's own `hostedBy` field -- the podId of the lane host a hosted
pod is a `child` of (issue #185 §7: "hosted pods are child-role pods of the
host pod").

### `ComputeRequest` placement fields

- `moduleType` now also accepts `'shell'` (alongside the existing `'wasm'`
  and `'js'`), for jobs that are a shell command rather than a
  wasm/js module.
- `constraints.isolation` (default `'any'`) is the request's lane
  requirement: `'any'` lets the scorer prefer a lane without requiring it;
  `'isolate'`/`'microvm'` hard-require that lane.
- Both are validated at construction time and round-trip through
  `toJSON()`/`fromJSON()`.

### `ResourceScorer` rules

`ResourceScorer.score()` applies the isolation lane **before** any of the
existing scoring (`preferRuntimeClass`, memory headroom, CPU, bandwidth --
all unchanged):

1. **Hard zero for `moduleType: 'shell'`** unless the descriptor advertises
   `runtime:microvm` -- a shell command can only ever run in a microVM pod,
   regardless of `constraints.isolation`.
2. **Hard zero when `constraints.isolation` is `'isolate'` or `'microvm'`**
   unless the descriptor advertises the matching `runtime:<isolation>`
   capability.
3. **`+25` lane preference when `constraints.isolation` is `'any'`**:
   `js`/`wasm` jobs get `+25` for `runtime:isolate`; `shell` jobs get `+25`
   for `runtime:microvm` (this is the same condition as rule 1's gate, so a
   shell job that clears the hard gate always gets the bonus too).

`ResourceScorer.lane(request)` is a static helper that reports the
*effective* lane for a request without consulting any descriptor --
`{ required, preferred }`, where `required` is set for a hard requirement
(explicit `isolation` or `moduleType: 'shell'`) and `preferred` is set when
`isolation` is `'any'` and the module type implies a lane. Useful for
logging/audit without re-deriving the scorer's own branching.

### `execOnPod()` isolate guard

Dispatching `execOnPod()` against a pod whose only advertised runtime class
is `'isolate'` (no `'microvm'`/`'node'`/`'browser'` class and no
`shellBackend`) is rejected before any remote dispatch: it records a
`remote_exec_denied` audit entry (`reason: 'isolate runtime cannot execute
shell commands'`, `layer: 'runtime'`, mirroring the existing
`remote_deploy_denied` record shape) and returns
`{ exitCode: 126, output: 'pod runtime "isolate" cannot execute shell
commands; use deploySkill or a microvm pod' }` instead of silently
dispatching a command the pod has no way to run. Use `deploySkill()`
(isolate pods can receive deployed skill code) or target a `'microvm'` pod
for shell execution.

### Placement audit vocabulary

`orchestrator.mjs` exports `PLACEMENT_AUDIT`, naming the placement
lifecycle this and future work packages write to the audit chain:
`placement_requested`, `placement_denied`, `placement_started`,
`placement_ready`, `placement_evicted` -- mirroring the existing
`remote_deploy_*`/`remote_exec_*`/`remote_compute_*` record families.
`MeshOrchestrator#recordPlacement(kind, details)` writes one through the
same `#recordAudit` path those use. The pod host service below is what
actually writes through it today, from both sides of a placement.

## Pod host service: spawning and controlling hosted pods

`createPodHostService()` is the gated, audited mesh service for **hosted
pods** — pods running on a machine someone else operates ([issue
#185](https://github.com/johnhenry/browsermesh/issues/185),
[`docs/hosted-pods.md`](../../docs/hosted-pods.md)). It serves one
lane-agnostic verb set:

```
spawn   status   send   exec   snapshot   restore   drain   list
```

The protocol itself — the verbs, the podspec, the lifecycle state machine,
the wire envelopes, the error codes — is plain data in
`@johnhenry/browsermesh-pod`'s `host-protocol.mjs`, deliberately *outside*
this package so a Worker or a microVM guest can import it without the app
runtime. What lives here is everything that needs a `PeerNode`:
`PeerRegistry.checkAccess()`, the `AuditChain`, and the orchestrator's
`PLACEMENT_AUDIT` vocabulary.

Every later surface is a projection of this one service: `mesh://` routes,
`meshctl` LLM tools, an external CLI, a supervisor. None of them should
re-implement access control, validation or audit.

### Hosting: attach the service

```js
import { attachService, createPodHostService } from '@johnhenry/browsermesh-apps'
import { InMemoryPodHostDriver } from '@johnhenry/browsermesh-pod'

const handle = attachService(peerNode, undefined, createPodHostService({
  driver: new InMemoryPodHostDriver({ lane: 'node' }),  // or a real lane driver
  resource: 'pod-host',        // ACL resource every verb is checked against
  auditChain,                  // optional; writes PLACEMENT_AUDIT records
  hostLabel: 'alice-laptop',
}))

handle.api.describe()
// { podId, lane: 'node', verbs: [...8], runtimeClasses: ['node'],
//   shellBackend: 'pty', deploymentSupport: { canDeploy: true },
//   capabilities: ['pod-host', 'exec'], resource: 'pod-host', hostLabel }

handle.api.runtimePeer()   // the runtime-registry peer shape the orchestrator reads
```

The `driver` is any object implementing `PodHostDriver` (a JSDoc typedef,
not a base class). Three exist today:

| Driver | Lane | Where |
| --- | --- | --- |
| `InMemoryPodHostDriver` | configurable (default `node`) | `@johnhenry/browsermesh-pod` — tests, examples, the reference implementation |
| `createVmPodDriver(vmPodHost)` | `microvm` | `spikes/vm-pod-host/src/driver.mjs` — Firecracker, via WP3's `VmPodHost` |
| `createIsolatePodDriver({baseUrl})` | `isolate` | `spikes/isolate-pod-host/src/driver.mjs` — workerd/Durable Objects, over HTTP |

### Driving: the client

```js
import { createPodHostClient } from '@johnhenry/browsermesh-apps'

const client = createPodHostClient({ peerNode, timeoutMs: 10_000 })

await client.spawn(hostPubKey, {
  name: 'transcoder',
  lane: 'microvm',
  run: { kind: 'command', ref: '/usr/bin/ffmpeg' },
  limits: { vcpus: 2, memMib: 512 },
  caps: ['net', 'fs'],
  budget: { credits: 25 },
  restart: { policy: 'on-failure', maxRestarts: 3 },
})

await client.exec(hostPubKey, 'transcoder', ['ffmpeg', '-version'])
await client.snapshot(hostPubKey, 'transcoder')
await client.restore(hostPubKey, 'transcoder')
await client.drain(hostPubKey, 'transcoder', { cascade: true })
await client.list(hostPubKey)
await client.describe(hostPubKey)

client.onEvent((hostPubKey, event) => {
  // event.kind is 'lifecycle' | 'log' | 'exit'
})
client.close()
```

One client talks to any number of hosts; responses are correlated by
`requestId`, so several verbs can be in flight at once. A request with no
answer inside `timeoutMs` rejects with `PodHostDriverError` / `ETIMEDOUT`,
and a remote `{code, message}` is rethrown as a local `PodHostDriverError`
— so `err.code === 'EACCES'` reads the same whether the refusal came from
the local driver or six hops away.

`MeshOrchestrator` wraps the four placement-shaped verbs and writes the
requester half of the audit trail itself:

```js
const orchestrator = new MeshOrchestrator({ peerNode, auditRecorder, podHostClient })
await orchestrator.spawnPod(hostPodId, spec)   // placement_requested → placement_ready
await orchestrator.snapshotPod(hostPodId, 'transcoder')  // placement_evicted
await orchestrator.restorePod(hostPodId, 'transcoder')   // placement_requested → placement_ready
await orchestrator.listHostedPods(hostPodId)
```

`podHostClient` is optional — one is built lazily from `peerNode` on first
use.

### Gating

Every verb is checked as `registry.checkAccess(pubKey, resource, verb)`,
i.e. the scope grammar is `pod-host:spawn`, `pod-host:exec`, … A denial
answers `EACCES`, emits `pod-host:denied` on the service's event bus, and
writes a `placement_denied` audit record. Verbs are independent: granting
`pod-host:status` does not grant `pod-host:exec`. A host serving several
tenants gives each its own resource (`resource: 'pod-host:tenant-a'`)
rather than trying to express tenancy inside one scope.

`describe()` is **not** gated, and travels on its own `pod-host:describe`
envelope rather than as a ninth verb: it returns only what the host would
publish in its announce metadata anyway, and a peer has to be able to find
out a host exists before it can ask to be granted anything on it.

### Which lane can do what

```js
import { POD_LANE_VERBS, laneSupports } from '@johnhenry/browsermesh-pod'
```

| Lane | `spawn` | `status` | `send` | `exec` | `snapshot` | `restore` | `drain` | `list` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `isolate` | ✓ | ✓ | ✓ | `ELANE` | `ELANE` | `ELANE` | ✓ | ✓ |
| `microvm` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `node` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `browser` | ✓ | ✓ | ✓ | `ELANE` | `ELANE` | `ELANE` | ✓ | ✓ |

`ELANE` means "this lane structurally cannot" (a V8 isolate has no shell);
`ENOTSUP` means "this driver did not implement an otherwise lane-compatible
verb" (WP3's `VmPodHost` has no message path yet, so the microvm driver
answers `send` with `ENOTSUP`). The distinction matters to a caller
deciding whether to retry elsewhere or give up on the whole lane.

### Observability and audit

The service's `attachService()` handle emits `pod-host:request`,
`pod-host:denied`, `pod-host:completed` and `pod-host:event`. With an
`auditChain`, the host writes `placement_requested` / `placement_started` /
`placement_ready` / `placement_denied` / `placement_evicted`. The requester
writes its own records through `MeshOrchestrator#recordPlacement()`: the two
chains are independent, with independent authors, by design — a host's audit
log is not evidence to the requester and vice versa.

### Known limitation: isolate hosts produce no compute descriptor

`runtimePeerToComputeDescriptor()` only returns a descriptor for peers whose
capabilities include `shell`/`exec`/`tools`. An isolate-lane pod host has no
`exec` by definition, so `podHostRuntimePeer()` output for one is correctly
scored as *not* a compute target and can only be reached through this service
directly, not through `dispatchCompute()`. Teaching the scorer that "can
spawn" is a kind of compute even without a shell is a change to WP4's scoring
surface, not to this service.

A runnable end-to-end walkthrough is
[`examples/13-pod-host-service.mjs`](../../examples/13-pod-host-service.mjs).

## License

MIT
