# wsh and browsermesh

[wsh](https://github.com/johnhenry/wsh) and browsermesh are two projects by the same author that overlap in
a few places and are kept apart in the rest. This page says what each is, where the code meets, how a capability in one
is written in the other, how a key relates, how to run objects across the mesh, what is deliberately not shared, and what
has not been verified. It describes this repository at the time of writing; where it names a wsh version it means that was
the version built and tested against. wsh's own view of the same boundary is
[`spec/wsh-and-browsermesh.md`](https://github.com/johnhenry/wsh/blob/main/spec/wsh-and-browsermesh.md) in the wsh
repository (written against wsh 0.52.0); the two pages describe one boundary and should agree.

**Versions.** The repository installs `@johnhenry/wsh` `^0.55.0` as a dev dependency (the root and `browsermesh-mcp`,
`browsermesh-netway`, `browsermesh-objects`, `browsermesh-primitives`, `browsermesh-transport` and `browsermesh-egress`), so
what its tests ran against is wsh **0.55.0**. The peer ranges are `>=0.49.0 <1.0.0` for `browsermesh-objects` and
`browsermesh-mcp`, an optional `*` for `browsermesh-transport` (its floors are listed under "Not verified") and an optional
`>=0.55.0 <1.0.0` for `browsermesh-egress` (its provider half takes wsh's address guard, `@johnhenry/wsh/address-guard`,
which first shipped in 0.55.0); `browsermesh-netway` and `browsermesh-primitives` have no wsh dependency beyond the dev one.

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
| A stock wsh client, or a mesh peer, using a pod's objects and MCP tools | `packages/browsermesh-transport/src/wsh-services.mjs` | `WshServices` (over a pipe relay, or `serveOnMesh` / `connectWshServicesOverMesh` over a mesh protocol channel); [design](design/wsh-services-on-a-pod.md), [over the mesh](design/wsh-over-mesh.md). Off unless constructed; objects and MCP only. |
| A pod carrying another pod's wsh session to a target (a mesh `--via`) | `packages/browsermesh-transport/src/wsh-relay.mjs` | `WshRelay`, `connectWshServicesViaRelay`, per-target grant `wsh-relay:<target>:open`; [design](design/wsh-over-mesh.md#the-relaying-pod-wshrelay), [threat model](security.md#a-relaying-pod-wsh---via-over-the-mesh). Off unless constructed. |
| The wsh TCP gateway as a virtual-network backend | `packages/browsermesh-netway/src/gateway-backend.mjs` | `GatewayBackend` speaks wsh's gateway control messages, including `GatewayCredit` flow control when the host states `gateway-credit`; its `GATEWAY_ERROR` codes are checked against wsh's exported `GATEWAY_FAIL_TABLE` (5 is `GATEWAY_DISABLED`, what the Rust server always sent; a timeout is 8 from wsh 0.52.0 on; a gateway at 0.51.0 or earlier still sends 5 for a timeout, so a received 5 is read as "the gateway is disabled, or a timeout from an older gateway", and a received 8 is thrown as an `OperationTimeoutError`), and it is tested against a hand-written mock and against a real wsh host (`gateway-real-wsh.test.mjs`: see "Not verified" for what that covers) |
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
| none | `egress:tcp:HOST:PORT:connect`, `egress:dns:NAME:resolve`, `egress:set:NAME:connect` | the egress package's own grants for an operator-lent network, not a translation of `gateway:*` ([capability-notation.md](capability-notation.md#egress-scopes)) |

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
  them. One narrow thing is different, and is stated here so the rule above is not read wider than it is: the egress package
  (`@johnhenry/browsermesh-egress`) lets a pod lend **its own** outbound network to a peer that holds an `egress:*` grant in
  that pod's registry. That is a scope family of its own, written by the operator for named destinations (or, with an
  explicit acknowledgement, any public one), checked against wsh's address guard on the provider, and it is not a wsh
  `gateway:` capability, does not run a wsh gateway for the peer and gives the peer no `exec`, files or endpoint. Mesh
  trust still never produces such a grant.
* **Discovery and sync.** Finding pods and merging their state stay in the mesh; nothing of them is pushed into wsh.

## Not verified

* Built and run against wsh 0.49.0, 0.50.0, 0.51.0, 0.52.0, 0.54.0 and 0.54.1 (tested range of `browsermesh-objects` and
  `browsermesh-mcp`: 0.49.0 to 0.54.1, the peer range starts at 0.49.0; the earlier ones were run when they were the newest,
  the last is what the repository now installs; 0.53.0 was never installed on its own, the repository went from 0.52.0 to
  0.54.0, so what 0.53.0 changed was run only as part of 0.54.0).
* wsh 0.53.0 and 0.54.0 put two deadlines on a wsh host: a connection that has not completed its login `loginTimeoutMs`
  (60 s) after the host accepted it is closed (refusal reason `login-timeout`), and with `sealSession: 'require'` a login that
  does not seal within `sealTimeoutMs` (30 s) is closed (`seal-timeout`). Here: `WshServices` and `WshPeerLinks` accept a host
  half at the relay when it connects, long before anyone pairs with it. With wsh 0.54.1 or later each such half is accepted
  with `accept(socket, { waitForPeer })`, and the login clock starts when the peer arrives: the half dials with `?paired=1`
  and `waitForPeer` is wsh's `watchPairing(socket).paired` (the relay reports the pairing), or the first byte the peer
  sends when that comes first or the relay predates the signal. A half that waits is neither refused nor closed however
  long it waits, and a peer that pairs and then does not log in is closed 60 s after it arrived (tested with a mocked
  clock against wsh's in-process relay, both with the paired signal and, for the waiting half, with the request taken off
  the URL as an older relay would). What remains: a peer that arrives and sends nothing is not bounded by the login
  deadline on a relay that predates the signal (the relay's own idle limit still ends it), which is one of the two gaps wsh
  documents; the other, a dial-out page host whose listener accepts and never sends, is not something these packages
  create. With an older wsh (no `waitForPeer`, detected by `watchPairing` missing from `@johnhenry/wsh/pipe-relay`) those
  hosts are created with `loginTimeoutMs: 0` instead: 0.54.0 would otherwise close every idle half each minute, and 0.53
  and earlier have no deadline; there a half is not bounded between pairing and login (the relay's own idle limit bounds a
  silent paired half). The optional peer range of `browsermesh-transport` stays `*` for that reason: the fallback keeps an
  older wsh behaving as before, and the fallback itself (no `watchPairing`) was not run against an older wsh (only the
  choice of options when `watchPairing` is absent is unit-tested). A mesh protocol channel is served from the moment the peer opens it and keeps the 60 s default. Neither package
  waits for a person inside the login (the registry decision is synchronous; the `authorize` callback of `WshPeerLinks`
  may be asynchronous, but a login that waits longer than the client's own `connectTimeoutMs` of 15 s is given up by the
  client first), so the 30 s seal limit is not reached by a legitimate peer on a healthy link; `sealTimeoutMs` is left at
  wsh's default. A deployment whose clients take longer than that to seal needs wsh's options, which these packages do not
  pass through. The deadlines were run against the in-process relay with a mocked clock, and a real wait of 60 s was not
  run. The relay option `retirePaired` is not used: the mesh link re-registers the same rendezvous id after a
  pairing and when it reconnects, which `retirePaired` would refuse. wsh 0.51 adds events through a handle and typed remotes (`rootDescription`) to the object
  layer; `browsermesh-objects` judges both through the registry. The object layer's MCP face (`exposeObjects({ mcp })`)
  is not exposed by `browsermesh-objects`: a page's tools go through `browsermesh-mcp`. They use its transport-neutral caller identity (`who: { username, fingerprint, podId }`, strict about 32
  bytes and canonical spelling, so a peer that is not named by a real pod id is refused), `serveMcpOverDuplex` with its
  `mcp-tool` / `mcp-call` hook, and `@johnhenry/wsh/testing` in the transport tests. `WshServices` needs 0.50 (its sessions
  begin at `onSealed`, the registry opens its channels through `authorizesItself`, and it can serve a mesh channel); the rest of `browsermesh-transport` still runs against wsh 0.45.0 and 0.49.0 (its tests pass on
  both, the services tests excepted on 0.45), and its published `wsh-in-process` subpath stays for the older wsh.
* wsh's capability vectors run in CI from the installed package (`REQUIRE_WSH_VECTORS=1` in the apps test script).
* The conversions in `ssh-keys.mjs` are run against `@johnhenry/wsh/identity` over valid and malformed input; the
  differences (this reader accepts leading blanks and a trailing tab, wsh accepts one trailing line break; this writer is stricter
  about comments, does not check the capability vocabulary and refuses a duplicate) are listed in
  `packages/browsermesh-primitives/test/wsh-identity-parity.test.mjs`.
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
* `GatewayBackend` is tested two ways. `gateway-backend.test.mjs` drives it with a hand-written mock client, which reaches
  corners a real host will not produce on request (a timeout code, a disabled gateway). `gateway-real-wsh.test.mjs`
  connects a real `WshClient` with a real Ed25519 login to a real wsh host and runs it end to end: against
  `createWshServer` (from `@johnhenry/wsh/server`) with a TCP gateway to a local echo server it covers connect, data in
  both directions, close from either end, refusal by policy, connection refused, name not found, resolve, too many
  connections and listen (bound and refused); it moves 4 MiB each way (origin to client, client to origin, and both at
  once through an echo) with every byte checked against a counter-hash pattern, which exercises wsh's `gateway-credit` flow
  control; a slow consumer on each side shows the held bytes stay bounded (at most the socket's 256 KiB window plus the
  256 KiB of credit granted); and one UDP datagram sent through the host reaches a real UDP socket (UDP is send-only: no
  reply is read). Against `createMemoryHost` it checks that TCP, DNS and listen are refused.
  The two hosts are the Node implementations joined to the client by an in-memory socket pair, not a network connection,
  and the test skips when `@johnhenry/wsh` is not installed. It was written against wsh 0.52.0 and now runs against 0.54.1;
  the Rust `wsh-server` was not run, a host from before `gateway-credit` was not run (that path is covered by
  `gateway-credit.test.mjs` against the mock only), no browser run covers the gateway path, and a gateway timeout (code 8)
  and an older gateway's 5 are checked only against the mock and wsh's exported code table (`gateway-parity.test.mjs`),
  not through a real host.
