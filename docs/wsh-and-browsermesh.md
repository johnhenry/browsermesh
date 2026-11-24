# wsh and browsermesh

[wsh](https://github.com/johnhenry/wsh) and browsermesh are two projects by the same author that overlap in
a few places and are kept apart in the rest. This page says what each is, where the code meets, how a capability in one
is written in the other, how a key relates, how to run objects across the mesh, what is deliberately not shared, and what
has not been verified. It describes this repository at the time of writing; where it says "wsh 0.48" it means that was the
version built and tested against.

## What each is

**wsh** is the authenticated, capability-scoped door into one machine or one page. A client logs in with an Ed25519 key
(optionally over a session sealed end to end), and the host gives that key exactly what its `authorized_keys` line says:
`exec`, `pty`, files, a TCP gateway, MCP tools, a remote-object protocol (`wsh-objects`) on a page, and so on. Its model is
a host, a key and a list of capabilities. There is a Node and browser implementation and a Rust server.

**browsermesh** is the peer fabric: pods with Ed25519 identities (a pod id is the hash of the key) that find and talk to
one another over WebRTC, WebSocket or relays, with CRDT sync, a capability registry per pod, signed and sealed messages,
and a virtual network. Its model is peers, and a registry of what each peer has been granted.

Short version: wsh is the door into one place; browsermesh is how many places talk to each other.

## Where they meet

| Meeting point | Where | Names |
| --- | --- | --- |
| A mesh link carried on a sealed wsh session | `packages/browsermesh-transport/src/wsh-links.mjs`, `wsh-pod-transport.mjs`, `wsh-frames.mjs`; `createMeshNode({ wsh })` in `packages/browsermesh-apps/src/mesh-bootstrap.mjs`, `wsh-negotiator.mjs` | `WshPeerLinks`, `WshLink`, `WshPodTransport`, `createWshTransportFactory`, `rendezvousId`; example 18; [design](design/wsh-peer-link.md), [adopting it](migration-wsh-peer-link.md). Optional peer `@johnhenry/wsh`, off by default. |
| wsh's remote objects over a mesh channel | `@johnhenry/browsermesh-objects` (`packages/browsermesh-objects`) | `exposeObjectsOnMesh`, `openObjectsOnMesh`; peers `@johnhenry/wsh/objects` and the protocol channel (`packages/browsermesh-apps/src/protocol-channel.mjs`, `protocol-roots.mjs`); example 19; [protocol channels](protocol-channel.md) |
| The wsh TCP gateway as a virtual-network backend | `packages/browsermesh-netway/src/gateway-backend.mjs` | `GatewayBackend` speaks wsh's gateway control messages; its error codes mirror wsh's by hand, and it is tested against a mock, not against a wsh host |
| One key | `packages/browsermesh-primitives/src/ssh-keys.mjs` | `podIdToFingerprint`, `fingerprintToPodId`, `openSSHPublicKeyFromRaw`, `rawPublicKeyFromOpenSSH`, `podIdFromOpenSSHPublicKey`, `authorizedKeysLine`; `PodIdentity#toOpenSSHPublicKey`, `#toAuthorizedKeysLine`. See [security.md, "One key in both worlds"](security.md#one-key-in-both-worlds) |
| One capability notation, tested | `packages/browsermesh-apps/test/capability-vectors.test.mjs`, `peer-registry.mjs` | wsh's vectors run against `PeerRegistry`; `isGrantableScope`; [capability notation](capability-notation.md) |
| A pipe relay on the relay server | the sibling repository `browsermesh-servers` | not in this repository |

## A capability, written both ways

The strings for the shared forms coincide. The full table, with where the two differ and which side was changed, is
[capability-notation.md](capability-notation.md); the short version:

| wsh key capability | mesh scope | a mesh check |
| --- | --- | --- |
| `objects:ROOT[:get\|call\|set\|on]` | the same string | `checkAccess(peer, 'objects:ROOT', op)` |
| `mcp:TOOL` | `mcp:TOOL` | `checkAccess(peer, 'mcp:TOOL', 'call')` |
| `rpc:NAME` | `protocol:NAME:open` | `checkAccess(peer, 'protocol:NAME', 'open')` |
| `expires="..."` | `grantCapabilities(peer, scopes, { expiresAt })` | refused at the instant, both |
| `exec`, `pty`, `fs:*`, `gateway:*`, `unix:*`, `endpoint:*`, `target:*`, `relay` | none | machine rights are not granted from mesh trust |

## Identity

A pod id is `base64url(SHA-256(raw Ed25519 public key))`. A wsh fingerprint is the same hash in hex, and an OpenSSH
`ssh-ed25519` line is the key itself. They are three names for one key, and primitives converts between them in one
place. The wsh peer link relies on it: a dialler logs in as `pod_<pod id>`, the host checks the name equals the hash of
the key wsh authenticated, and a host key is pinned to the pod id the dialler meant to reach.

Having the same key valid in both worlds is possible and is **never automatic**. Nothing in this repository writes a key
to a machine's `authorized_keys`, and a pod's key usually lives in browser storage, so listing it on a machine lets
whoever can use that browser profile reach the machine. Read
[security.md, "One key in both worlds"](security.md#one-key-in-both-worlds) before doing it.

## Running objects across the mesh

Objects, not shell: one pod exposes named roots (`app`), another reaches them by path under two authorisations, wsh's
allow-lists and the host's registry grants for the verified peer, each operation by its own action (`get`, `call`,
`set`, `on`). No wsh relay or wsh login is involved; the link is a mesh protocol channel.

```js
// host
const objects = exposeObjectsOnMesh(service, { roots: { app }, allow: { get: ['app.title'], call: ['app.counter.inc'] } })
registry.grantCapabilities(peerPodId, [protocolScope('objects'), 'objects:app:get'])
// peer
const { roots } = await openObjectsOnMesh(service, hostPodId)
await roots.app.title
```

`npm run example:19` runs it, and `packages/browsermesh-objects/README.md` lists what each operation needs, how revocation
and bounds behave, and what an older peer does.

**MCP across the mesh** (a page's WebMCP tools reachable from another browser over a protocol channel, no wsh relay) is
`@johnhenry/browsermesh-mcp`: `serveMcpOnMesh`, `openMcpOnMesh` and `MeshMcpTransport`, on the protocol `mcp`. A peer
needs `protocol:mcp:open` to open it and `mcp:<tool>:list` / `mcp:<tool>:call` per tool (the same strings as a wsh
key's `mcp:TOOL`, with the action spelled out; `mcp:*:list` and `mcp:*:call` are every tool). Approval of a call stays
with the serving page. Design: [`design/mcp-over-mesh.md`](design/mcp-over-mesh.md); what it protects:
[`security.md`](security.md).

**wsh services on a pod** (`WshServices`, in `browsermesh-transport`): a stock wsh client may use a pod's objects and MCP
tools. It is off by default, serves objects and MCP only (never exec, pty, files, the gateway or any endpoint), is opt-in
per pod, and is permitted only by the pod's registry grants for the connecting key's pod id (not by wsh key options).
The grants are the same scopes as above. Design: [`design/wsh-services-on-a-pod.md`](design/wsh-services-on-a-pod.md).

## What is deliberately not shared

* **The two sealing schemes.** A wsh session is sealed once for its length (X25519 and ML-KEM-768, both halves signed). A
  mesh message routed through other peers is sealed one message at a time to a pod's signed key statement. They answer
  different questions, are not interchangeable, and are not translated.
* **The wire encodings.** wsh speaks CBOR on its own transports; the mesh's frames are JSON text or bytes. The wsh peer link
  carries mesh frames inside a wsh endpoint and does not change either.
* **Addressing.** A wsh host is a name or a rendezvous id on a relay; a pod is a pod id. They are mapped where a link needs
  it (`rendezvousId`), nowhere else.
* **exec, pty, files, the gateway and hosted pods.** These are machine rights. Mesh trust, a mesh grant or being reachable on
  the mesh never gives them, and no code derives one from the other. A machine's own `authorized_keys` says who gets
  them.
* **Discovery and sync.** Finding pods and merging their state stay in the mesh; nothing of them is pushed into wsh.

## Not verified

* Everything here was built and run against wsh 0.48.0. wsh 0.49.0 (a neutral caller identity for the objects layer, the
  capability vectors in the package, an identity conversion export, test doubles) was not published when this was
  written, and none of it is used. `browsermesh-objects` hands the layer `who.podId` and reads it back, which 0.48 passes
  through untouched; whether a later wsh keeps that is not known.
* wsh's capability vectors were run against the registry from a working copy of the vector file (the package did not ship
  it yet); in CI that test skips until a wsh that ships the file is installed.
* That an `rpc` channel works on a sealed session from wsh 0.46.0 is wsh's claim (johnhenry/wsh#191) and was not re-tested
  here. The repository's own wsh link tests (116, plus example 18) pass on wsh 0.45.0, 0.46.0, 0.46.1, 0.47.0 and 0.48.0.
* The wsh peer link is tested over an in-process pipe relay and real wsh handshakes; it is not run in a browser, and
  not against the real relay server.
* Objects over the mesh run in real Chromium, Firefox and WebKit over real WebRTC, but the page runs wsh's transport-neutral
  object core directly (`/vendor/wsh/` in the harness), not the package entry point that also loads wsh's client.
* An `authorized_keys` line from `toAuthorizedKeysLine` was parsed by wsh's parser in process; it was not tried against a
  running `wsh-server` or `sshd`. Nothing claims a way to turn an OpenSSH private key into the PKCS#8 that `fromPkcs8`
  reads.
* The Rust `wsh-server` has no `wsh-objects`, no named endpoints and no execution targets; none of the object work above
  applies to it.
* `GatewayBackend` has been run against a mock of wsh's gateway, not a wsh host.
