# browsermesh examples

Small, self-contained, runnable demonstrations of real browsermesh behavior.
Every example runs headless under plain Node (>= 24) with no browser, no
network, and no server — peers, transports, and sockets are simulated
in-process, but the actual protocol/CRDT/capability logic exercised is
exactly what runs in production.

Run one with `npm run example:01` (etc.), or all of them with `npm run examples`.

| Example | Demonstrates |
|---|---|
| [`01-identity-and-signed-messages.mjs`](./01-identity-and-signed-messages.mjs) | Ed25519 identity, deterministic `podId` derivation, signature verification rejecting tampered payloads and wrong signers, and the binary wire format round-tripping exactly. |
| [`02-two-pods-discover-and-message.mjs`](./02-two-pods-discover-and-message.mjs) | Two `Pod` instances boot, run the real HELLO/HELLO_ACK discovery handshake over a shared transport, and exchange a direct message. |
| [`03-virtual-network-loopback.mjs`](./03-virtual-network-loopback.mjs) | `VirtualNetwork`'s listen/connect/accept/read/write moving real bidirectional byte streams, including exact binary round-trips. |
| [`04-kernel-capability-denial.mjs`](./04-kernel-capability-denial.mjs) | Two kernel tenants with different capability grants — the same operation succeeds for one and throws `CapabilityDeniedError` for the other; the security boundary is enforced, not just documented. |
| [`05-crdt-sync-across-two-engines.mjs`](./05-crdt-sync-across-two-engines.mjs) | Two independent `MeshSyncEngine` instances converge on identical state after exchanging CRDT sync payloads in arbitrary order — no coordinator, no app-level conflict resolution. |
| [`06-mesh-relay.mjs`](./06-mesh-relay.mjs) | One peer (`MeshRelayHost`) shares access to its own `VirtualNetwork` with a specific, authorized mesh peer (`MeshRelayBackend`) — an ungranted attempt is refused, a granted one relays real bytes to a real local service and back, and revoking access denies the next attempt. |
| [`07-full-mesh-pipeline.mjs`](./07-full-mesh-pipeline.mjs) | The full story in one script: two peers discover each other, connect, converge on shared CRDT state (`MeshSyncEngine`), run kernel-gated application code over that connection (`Kernel`'s mesh capability), and relay through to a shared local service (`MeshRelayHost`/`MeshRelayBackend`) — all riding the SAME connection at once. See `packages/browsermesh-apps/test/real-peer/full-pipeline.test.mjs` for the identical composition proved over a real WebRTC connection. |
| [`08-mesh-fetch-websocket.mjs`](./08-mesh-fetch-websocket.mjs) | `browserMeshFetch()` (a `fetch()`-shaped request/response round trip to a real mesh-RPC handler, including a non-2xx route resolving as a real `Response` rather than rejecting) and `BrowserMeshWebSocket` (a persistent duplex channel, including both the accept and reject halves of its open handshake) — the two web-standard-API-shaped wrappers over a mesh connection. |
| [`09-cloud-storage.mjs`](./09-cloud-storage.mjs) | `CloudStorage`, an S3-like object store with no server anywhere: encrypted-at-rest content (AES-256-GCM), a signed replicated ACL (`GrantLog`), bucket-key distribution, and CRDT manifest sync + chunk replication, all behind `put`/`get`/`delete`/`list`/`grant`/`revoke`/`designateReplica` — an unauthorized peer denied cleanly, and a revoked peer's next read denied too (with the permanent "already-delivered content stays readable" limitation shown, not hidden). See `packages/browsermesh-apps/test/real-peer/cloud-storage.test.mjs` for the identical composition proved over a real WebRTC connection, and `packages/browsermesh-apps/docs/building-mesh-services.md` for the reusable design pattern this example is the worked example of. |
| [`10-mesh-kv-and-observability.mjs`](./10-mesh-kv-and-observability.mjs) | `MeshKv`, a small mesh-native key-value store (`get`/`set`/`delete`/`keys`, no chunking, no encryption-at-rest), doing real ACL-gated multi-peer work — an admin grant, an authorized peer writing back, an unauthorized peer's write refused — while a live `ctx.emit()` event stream feeds an `observability-bridge` instance in real time. Ends by printing the bridge's `VisualizationExporter` topology and trust-heatmap JSON, built entirely from real emitted events, not mock data. See `packages/browsermesh-apps/docs/building-mesh-services.md` (§7-8) for the `ctx.emit()` convention and this service's own retrospective against `09-cloud-storage.mjs`. |
| [`11-agent-tool-calling.mjs`](./11-agent-tool-calling.mjs) | The issues #90/#92 capstone: two real `createMeshNode()` peers (`enableOrchestrator` + `enableAgentRuntime` on one of them), a deterministic test `llmFn` (no real LLM API call — browsermesh's "bring your own LLM callback" design), and a real `createAgentRuntime()` dispatch loop — the LLM requests `meshctl_pods` then the genuinely risky, `checkAccess()`-gated `meshctl_exec`, both really dispatched through a real `BrowserToolRegistry` to a real `MeshOrchestrator` over a real two-peer mesh, with the results flowing back into the conversation for the final answer. See `packages/browsermesh-apps/docs/building-mesh-services.md`'s "`BrowserTool`/`BrowserToolRegistry`/agent runtime" section for the reusable pattern this example demonstrates, distinct from the `MeshService` pattern the rest of this guide covers. |
| [`12-hosted-pod-over-websocket.mjs`](./12-hosted-pod-over-websocket.mjs) | Issue #185 ("Hosted pods") work package 1: two `Pod` instances discover each other and exchange a message over `WebSocketTransport` — the adapter that speaks the real `browsermesh-servers` relay/signaling wire protocol (`register`/`registered`, `relay`/`relayed`, `peers`/`peer-joined`/`peer-left`), simulated in-process here, so a `Pod` can run outside a browser tab (a V8 isolate, a microVM, a plain Node process) and still join the mesh. Demonstrates the point-to-point fan-out workaround for the relay's lack of a broadcast primitive, seeded via `peersFromSignaling`. |
| [`13-pod-host-service.mjs`](./13-pod-host-service.mjs) | Issue #185's **hosted-pods control surface**: alice hosts pods (`createPodHostService()` over an `InMemoryPodHostDriver`, lane `node`), bob is granted all eight verbs and spawns a pod on her, execs in it, snapshots it, restores it and drains it while watching the lifecycle stream back live; carol is refused with `EACCES` and a `pod-host:denied` event, yet can still `describe()` the host, because discovery is deliberately ungated. One lane-agnostic verb set (`spawn, status, send, exec, snapshot, restore, drain, list`) over two real `PeerNode`s — swap in `spikes/vm-pod-host`'s or `spikes/isolate-pod-host`'s driver and nothing above the driver changes. |
| [`14-pod-host-over-mesh-fetch.mjs`](./14-pod-host-over-mesh-fetch.mjs) | Issue #185 control-surface item 3, the HTTP-shaped projection of the pod-host service: the same spawn → status → exec → snapshot → restore → drain lifecycle driven two ways against one `InMemoryPodHostDriver` host — bob, a mesh peer, via `podHostFetch()` over real `mesh://` routes (`createPodHostRouter()` mounted under `createMeshRpcService({onRequest})`), and then, from entirely outside the mesh, over a real `node:http` server (`serveNodeGateway()`) fronting `createPodHostGatewayHandler()`, authenticated with a bearer token and printing each call's actual HTTP status code (201/200/204/401/403/404). The one exception to this directory's "no server" convention — the gateway needs a real loopback `node:http` listener to demonstrate "driven from outside the mesh" honestly; everything else here still runs in-process. |
| [`15-agent-spawns-hosted-pod.mjs`](./15-agent-spawns-hosted-pod.mjs) | Issue #185 §8a item 4's **`meshctl` LLM tools for the hosted-pods control surface**, told the same way `11-agent-tool-calling.mjs` tells issues #90/#92: a deterministic test `llmFn` driving a real `createAgentRuntime()` loop over a real `BrowserToolRegistry` pre-populated with all 15 `meshctl_*` tools. The LLM calls `meshctl_hosts` to discover a pod host, `meshctl_spawn` with `host: 'auto'` to let the orchestrator pick it ("orchestrator proposes, host accepts"), `meshctl_hosted_pods` to confirm what landed, `meshctl_snapshot`/`meshctl_restore` to round-trip it, and finally the pre-existing `meshctl_drain` to drain the host pod itself — five new tools composing with the original eight, not just sitting alongside them. |
| [`16-supervised-hosted-pods.mjs`](./16-supervised-hosted-pods.mjs) | Issue #185 item 6's **pod supervisor** -- `createPodSupervisor()`'s links/monitors/restart policy over the same eight-verb control surface, told the OTP way: bob supervises a pod on alice's host with `restart: 'on-failure'`, crashes it twice via the driver's test-only `crash()` and watches two real restarts land with doubling backoff (50ms, then 100ms) -- "a restart is a new spawn request the host may refuse," never the driver bypassed directly -- links a child to the parent with `links.parent`, then `drain(parent, {cascade: true})` drains the child first, depth-first, before the parent. Prints the full `supervisor:*`/monitor event log the run produced. |

These cover the five foundational packages (`browsermesh-primitives`,
`-pod`, `-netway`, `-kernel`, `-sync`) plus `browsermesh-apps`'s mesh-relay
composition (`06`), its full discovery+sync+kernel+relay composition (`07`),
its `fetch()`/`WebSocket`-shaped mesh wrappers (`08`), its mesh-native
CloudStorage service (`09`), its mesh-native KV store plus observability
bridge (`10`), its LLM-tool-calling agent runtime over a real
`MeshOrchestrator` (`11`), and `browsermesh-pod`'s relay-backed
`WebSocketTransport` for pods hosted outside the browser (`12`). The
higher-level packages built on top of them
— `browsermesh-core`,
`-transport`, `-discovery`, most of `-apps`, `browsermesh-embed` — are
exercised end-to-end in a real browser by
[clawser](https://github.com/erisera-code/clawser)'s Mesh and Peers panels;
see their own package READMEs for API-level usage.

## Hosted pods

Every example above runs a `Pod` the way the browser (or a single Node
process) already supports: same-origin tabs, workers, or an in-process
`EventEmitterTransport` bus. [`docs/hosted-pods.md`](../docs/hosted-pods.md)
at the monorepo root designs the next step — running a `Pod` on a machine
someone else operates, in a V8 isolate or a Firecracker microVM, with the
orchestrator choosing the lane per job. Three examples above come from that
design and all run here, headless, with no isolate and no KVM host:
`12-hosted-pod-over-websocket.mjs` (WP1: two Node pods discovering each
other through an in-process fake relay), `13-pod-host-service.mjs` (the
control surface: spawning and driving hosted pods over the mesh, gated and
audited), `14-pod-host-over-mesh-fetch.mjs` (control-surface item 3: the
same control surface as `mesh://` HTTP routes, plus a Node HTTP gateway for
driving it from entirely outside the mesh), and
`15-agent-spawns-hosted-pod.mjs` (item 4: the same control surface projected
as `meshctl_*` LLM tools, driven by a real `createAgentRuntime()` loop). The
real lanes live in `spikes/isolate-pod-host` and `spikes/vm-pod-host`, which
are not part of `npm run examples` because one needs `wrangler`/`workerd` and
the other needs Linux + `/dev/kvm`.
