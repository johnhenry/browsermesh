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

These cover the five foundational packages (`browsermesh-primitives`,
`-pod`, `-netway`, `-kernel`, `-sync`) plus `browsermesh-apps`'s mesh-relay
composition (`06`) and its full discovery+sync+kernel+relay composition
(`07`). The higher-level packages built on top of them — `browsermesh-core`,
`-transport`, `-discovery`, most of `-apps`, `browsermesh-embed` — are
exercised end-to-end in a real browser by
[clawser](https://github.com/erisera-code/clawser)'s Mesh and Peers panels;
see their own package READMEs for API-level usage.
