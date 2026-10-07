---
"@johnhenry/browsermesh-apps": minor
---

Add the pod host service (`src/pod-host-service.mjs`, issue #185's hosted-pods control surface): the gated, audited mesh service that speaks `@johnhenry/browsermesh-pod`'s pod host protocol, so one peer can spawn and drive pods hosted on another.

- `createPodHostService({driver, resource, auditChain, hostLabel, shellBackend})` — a `MeshService` descriptor. Each of the eight verbs (`spawn`, `status`, `send`, `exec`, `snapshot`, `restore`, `drain`, `list`) is checked as `registry.checkAccess(pubKey, resource, verb)`; a denial answers `EACCES`, emits `pod-host:denied` and writes a `placement_denied` audit record. Payloads are validated and normalized before any driver sees them. Driver lifecycle/log/exit events are forwarded to the peers that addressed the pod. Its `api` exposes `describe()` and `runtimePeer()`.
- `createPodHostClient({peerNode, timeoutMs})` — one method per verb plus `describe()` and `onEvent()`, correlated by `requestId`, timing out with `ETIMEDOUT`, rethrowing remote `{code, message}` failures as `PodHostDriverError` so `err.code === 'EACCES'` reads the same locally and remotely.
- `MeshOrchestrator` gains `spawnPod()`, `snapshotPod()`, `restorePod()` and `listHostedPods()`, plus a `podHostClient` constructor option (lazily built from `peerNode` when omitted), writing the requester half of the `PLACEMENT_AUDIT` trail through the existing `recordPlacement()`.
- `podHostRuntimePeer(description)` projects a host into the runtime-registry peer shape `runtimePeerToComputeDescriptor()` already reads.
- `POD_HOST_DESCRIBE` is a separate, deliberately ungated envelope rather than a ninth verb: it returns only what a host publishes in its announce metadata, and a peer must be able to discover a host before it can ask to be granted anything on it.

`@johnhenry/browsermesh-pod` becomes a (non-optional) peer dependency: the protocol half of this feature lives there so a Worker or a microVM guest can import it without the app runtime.

Known limitation, documented in the README: `runtimePeerToComputeDescriptor()` only produces a descriptor for peers advertising `shell`/`exec`/`tools`, so an isolate-lane pod host — which has no `exec` by definition — is not scored as a compute target and must be reached through this service directly.

Over a real transport (WebRTC or WebSocket data channel) the host's reply and its lifecycle events reach the client as JSON text, not objects (browsermesh#208). `createPodHostClient()` subscribes to the raw `PeerNode.onIncomingData()` bus, so it now parses those strings the same way `ctx.onIncomingData()` does for services; before, every response was dropped and every call timed out with `ETIMEDOUT` outside in-process tests. Covered by a real-WebRTC suite (`test/real-peer/pod-host.test.mjs`).
