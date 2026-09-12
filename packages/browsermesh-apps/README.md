# browsermesh-apps

Application layer for BrowserMesh: marketplace, chat, payments, compute orchestration, and agent tools.

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
| peer-session | `PeerSession`, `SessionManager` |
| peer-terminal | `TerminalHost`, `TerminalClient` |
| peer-timestamp | `TimestampAuthority`, `TimestampProof` |
| peer-torrent | `TorrentManager` |
| peer-verification | `VerificationQuorum`, `Attestation` |
| marketplace-ui | `SkillMarketplace` |

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
import { MeshChat, AppRegistry, MeshOrchestrator } from 'browsermesh-apps';
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

## License

MIT
