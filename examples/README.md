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

These cover the five foundational packages (`browsermesh-primitives`,
`-pod`, `-netway`, `-kernel`, `-sync`) plus `browsermesh-apps`'s mesh-relay
composition (`06`), its full discovery+sync+kernel+relay composition (`07`),
its `fetch()`/`WebSocket`-shaped mesh wrappers (`08`), its mesh-native
CloudStorage service (`09`), its mesh-native KV store plus observability
bridge (`10`), and its LLM-tool-calling agent runtime over a real
`MeshOrchestrator` (`11`). The higher-level packages built on top of them
— `browsermesh-core`,
`-transport`, `-discovery`, most of `-apps`, `browsermesh-embed` — are
exercised end-to-end in a real browser by
[clawser](https://github.com/erisera-code/clawser)'s Mesh and Peers panels;
see their own package READMEs for API-level usage.
