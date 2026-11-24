# What is protected today, and what is implemented

This is the one document about what the code in this repository protects, and
how far each part is built and tested. It answers
[issue #269](https://github.com/johnhenry/browsermesh/issues/269). It is
written from the source and the tests, not from intent. Where code does not do
something, it says so. The relay and signaling servers live in another
repository (`browsermesh-servers`) and are not covered by anything here.

Contents: [how to read it](#how-to-read-it) ·
[implementation status per package](#implementation-status-per-package) ·
[identity](#identity) · [pod messages](#pod-messages) ·
[peer links by transport](#peer-links-by-transport) · [relay](#relay-mesh-relay) ·
[shared servers](#shared-servers) · [mesh-rpc, message channel, protocol seam](#mesh-rpc-the-message-channel-and-the-protocol-seam) ·
[sync](#sync) · [discovery and StealthAgent](#discovery-and-stealthagent) ·
[hosted pods](#hosted-pods-per-lane) · [what is verified how](#what-is-verified-how)

## How to read it

For each layer: what is **authenticated**, what is **confidential** (and from
whom), what is **bounded**, what is **not protected**, the **option** that turns
each protection on and its **default**, and how it was **verified**.

"Peer key" means the key of the session a message arrived on, as reported by
the transport (for example `PeerNode.onIncomingData()`). It is never a field of
the message. How strongly that key is verified depends on the link (see
[peer links](#peer-links-by-transport)).

Verification levels used below:

- **unit**: tests in the package with mocks or in-process objects.
- **duplex**: an in-memory duplex of two real objects (for example two
  `WebRTCPeerConnection`s joined by a fake channel), no network.
- **real peer**: `npm run test:real-peer`, a native WebRTC binding in Node.
- **real browser**: `npm run test:browser` (Playwright, strict CSP; Chromium, Firefox and WebKit run in CI, and
  the WebKit job is allowed to fail). The relay and
  signaling servers there are in-repo test doubles. See `tests/browser/README.md`.
- **never**: not exercised by any test.

## Implementation status per package

Classes: **implemented** (real code and tests that exercise it), **partial**
(real code with stated gaps, stubs, or only mocked tests), **spec only**
(design or comments, or throws not-implemented). Per-module notes follow the
table; they come from the READMEs, source headers and test directories.

| Package | Status | Notes |
| --- | --- | --- |
| `browsermesh-primitives` | implemented | identity, session certificates, wire format, CRDTs, ACL, capability scopes, trust graph, padding. Unit tests; identity also in a real browser. Trust edges are unsigned. Session certificates are not wired into the handshake or any transport. |
| `browsermesh-core` | implemented, with partial modules | identity managers and vault storage, keyring, capability tokens, group keys, ACL, trust: implemented (unit). `handshake.mjs`: partial (connection token is unsigned and the pod id is not checked against the key; mock transports). `hardening.mjs` and `peer.mjs`: marked experimental in source. `compat.mjs`: shim whose `BrowserTool#execute()` throws not-implemented by design. |
| `browsermesh-pod` | implemented | pod, messaging and signing, discovery, host protocol, runtimes (worker_threads, permission-model), `WebSocketTransport` and BroadcastChannel transports (unit and real browser). `browser-host-driver`: partial (`exec` is deliberately not offered in the browser lane; `snapshot` and `restore` not implemented). |
| `browsermesh-transport` | implemented, with partial modules | WebSocket, WebRTC (unit, real peer, real browser); wsh links (real wsh handshake over an in-process relay; not a browser); identity binding (duplex only). WebTransport, relay client, wisp (mocks only). `channel-relay`, `gateway`, `cross-origin`, `streams` (unit). `NATTraversal` in `websocket.mjs`: placeholder values, partial. |
| `browsermesh-apps` | implemented, with partial modules | registry, grant log, audit, mesh-rpc, mesh-fetch, message channel, protocol seam, relay host and backend, sync, cloud storage, key distribution, KV, escrow, pod-host service, placement, supervisor: implemented (mostly in process; a few over real peers). Partial: `mesh-bootstrap` (one real-peer test file), torrent (single-process fallback; real WebTorrent only under `test/real-torrent`), `peer-ipfs` (a local SHA-256 store, not IPFS), `peer-terminal` (no default shell), serverless executors (not an adversarial sandbox), GPU (real WebGPU only in a dedicated test), `mesh-dht` (no authentication), `compat.mjs`. Spec only: `wsh-objects` over the protocol seam. |
| `browsermesh-sync` | implemented, with partial modules | CRDT, delta sync, memory sync, file chunks, CIDv1, IndexedDB storage (unit, `fake-indexeddb`); CRDT convergence also over a real data channel in a browser. `collab` and `collab-bridge`: partial (marked experimental; stub document when Yjs is absent). |
| `browsermesh-discovery` | partial | DHT has no iterative lookup (below); discovery strategies unsigned; naming, swarm, service-worker routing implemented (unit, unauthenticated); StealthAgent plain path documented as plaintext, encrypted/keyring path implemented; threshold key sharing is spec only (`docs/design/stealth-threshold.md`). |
| `browsermesh-netway` | implemented | loopback, virtual network, policy, queue, sockets (byte-level backpressure), listener, router, service and fs backends, chaos wrapper (unit). `gateway-backend`: partial (mock wsh transport only). `backend.mjs`: abstract base. |
| `browsermesh-kernel` | implemented | in-process microkernel with capability checks and resource tables; unit tests per module. No cryptography; isolation is by capability and ownership checks, not process boundaries. |
| `browsermesh-priority-mux` | implemented | sender-side priority scheduler and framer (fake adapter tests). No authentication or encryption. The reassembler has no limit on pending messages. |
| `browsermesh-embed` | partial | widget wrapper tested against a DOM stub only. |
| `browsermesh-meshctl` | partial | loopback mode exercised through all eight verbs; the real-mesh path is wired, not exercised end to end; `--relay` is not load-bearing. |
| `spikes/*` | spikes | `vm-pod-host` (Firecracker driver: never booted a VM), `isolate-pod-host`, `browser-pod-host`, `browser-extension-host`; see [hosted pods](#hosted-pods-per-lane). |

Netway's README now lists the capability tags that exist in
`src/constants.mjs` (`TCP_CONNECT`, `TCP_LISTEN`, `UDP_SEND`, `UDP_BIND`,
`DNS_RESOLVE`, `LOOPBACK`, `ALL`); it previously named `NET`, `DNS` and `RAW`,
which do not exist there.

## Identity

Packages: `browsermesh-primitives`, `browsermesh-core`.

- **What it is.** A pod id is `base64url(SHA-256(raw Ed25519 public key))`.
  There is no software Ed25519 fallback: a browser without WebCrypto Ed25519
  cannot use the identity layer.
- **Key storage.** `PodIdentity.generate()` makes an *extractable* key by
  default; `{ extractable: false }` is opt-in. `fromJwk`/`fromPkcs8` import
  non-extractable. `fromSigner` takes an external signer (no exportable key).
  `MeshIdentityManager` stores keys through `InMemoryIdentityStorage` (default),
  `IndexedDBIdentityStorage` (the JWK is stored in the clear) or
  `VaultIdentityStorage` (opt-in; PBKDF2-SHA-256 then AES-256-GCM through a
  caller-provided passphrase).
- **Authenticated.** Signatures verify against the key whose hash is the pod id.
  Capability tokens are signed only if the issuer signs them (a plain
  `new CapabilityToken()` is unsigned; `verifySignatures` is separate from the
  structural check). Keyring links and unlinks are signed by both ends.
- **Rotation and revocation.** No automatic rotation of the identity key.
  Keyring unlink and `retireIdentity` are the revocation paths. Session
  certificates (a short-lived session key signed by the identity key, default
  maximum 24 h, signed revocations) exist in `primitives` but nothing else
  imports them.
- **Not protected.** The handshake connection token (QR/clipboard) is unsigned
  and `validateToken` does not check that the claimed pod id equals the hash of
  the public key; a replayed nonce is refused (default cap 10000 nonces). Trust
  graph edges and group-key use have no per-sender signature (any key holder can
  encrypt as anyone). `padding` hides message size only (buckets of 256, 1024,
  4096, 16384 bytes), not timing; it is off unless asked for.
- **Verified.** Unit throughout; Ed25519 generate/sign/verify across two real
  browsers (`tests/browser/policy-and-identity.spec.mjs`). Handshake: unit with
  mock transports.

## Pod messages

Package: `browsermesh-pod` (`Pod`, `signed-message.mjs`). For `pod:message`,
`pod:rpc-request` and `pod:rpc-response`.

- **Authenticated.** The sender is the key that signed the message, or the
  identity the link itself authenticated, never a field the sender or a relay
  wrote. A signed message carries `pk`, a session id `sid`, a counter `seq` and
  an Ed25519 `sig` over `"browsermesh/pod-message/v1\n"` plus the canonical JSON
  of sender, recipient, type, body, `ts`, `pk`, `sid`, `seq`. The receiver checks
  that `from` equals the pod id of `pk`, that the signature verifies, and that
  `(sid, seq)` is new. A relay that rewrites, re-addresses, retypes or adds
  fields is detected; only the signed fields are delivered, with
  `authenticated: true`.
- **Link-authenticated.** A transport may call its handler as
  `handler(msg, { peerId })`; the sender is then that id, a mismatching `from`
  is dropped, and no per-message signature is required. `WshPodTransport` does
  this.
- **Bounded.** Replay window of the last 64 sequence numbers per sender session;
  4 sessions per sender, 1024 senders, in memory. Drops are counted in
  `pod.dropped` by reason (`unsigned`, `unsigned-rpc`, `malformed`,
  `sender-mismatch`, `bad-signature`, `replay`) and emitted as `message:dropped`.
- **Options and defaults.** `sign` (default `true`). `allowUnsigned`: default
  `true` only for transports that declare `trust === 'same-origin'`
  (`BroadcastChannelTransport`, `EventEmitterTransport`, `NullTransport`) and
  for window messages; `false` for `WebSocketTransport` and for any custom
  adapter that does not declare `trust`. An unsigned `pod:rpc-request` is never
  accepted. `send()` and `broadcast()` return promises.
- **Not protected.** Confidentiality: a signed message is readable by the relay
  and by every peer that forwards it. A relay can drop or delay messages.
  Replay state is in memory: a copy from a session the receiver forgot, or sent
  after the receiver restarted, is not recognised. Same-origin delivery trusts
  the origin: any script of the origin can post under any pod id. `pod:hello`,
  `pod:hello-ack` and `pod:goodbye` are unsigned and only change the peer list.
  `MeshRouter`'s forwarded envelopes (`from`, `path`) in `browsermesh-apps` are
  written by each hop and are not covered.
- **Verified.** Unit (`message-authenticity.test.mjs`, with a hostile relay,
  fixed vectors and each signed field shown to be covered); real browser for
  messaging over BroadcastChannel and over the WebSocket relay (signed by
  default).

## Peer links by transport

| Link | Encrypted against the network | Encrypted against a relay | Who the peer is, as far as this code checks | On by default | Verified |
| --- | --- | --- | --- | --- | --- |
| `BroadcastChannelTransport` (pod) | the browser's same-origin isolation | no relay | any same-origin context on that channel name | yes (pod default) | unit; real browser (also across two origins: invisible) |
| `WebSocketTransport` (pod, relay protocol) | TLS only if the URL is `wss://` | **no**: the relay reads every envelope | pod messages are signed (see above); the relay's `source` is passed as `relaySource` and not believed; the `register` frame sends no proof of key | pods sign by default; `allowUnsigned` false here | unit; real browser against a test-double relay |
| `WebSocketTransport` / `WebTransportTransport` (transport package) | as above | no | none by the transport itself; optional `padding` and `jitterMs` hide sizes and timing from a network observer, not from the relay | padding and jitter off | WebSocket: unit and real browser (text, 1 MiB binary); WebTransport: mock only |
| WebRTC (`WebRTCPeerConnection`, `WebRTCMeshManager`) | DTLS (standard data channel encryption) | the signaling relay carries offers and answers, including DTLS fingerprints | signaling names the peer's pod id. With `identity` set, each side proves possession of its pod key over both descriptions' DTLS fingerprints (a swapped description is detected, the connection is closed); a peer sending no proof is closed after `bindingTimeoutMs` (10 s) unless `requirePeerBinding: false`. A renegotiation whose fingerprint changes is rejected | **binding off**; `createMeshNode()` does not enable it | DTLS channel: unit, real peer, real browser. Binding: duplex and fixed vectors only; never over a real `RTCPeerConnection` |
| **wsh link** (`WshPeerLinks`, `WshPodTransport`) | sealed end to end (authenticated encryption, X25519 + ML-KEM-768) | **sealed: ciphertext only** | the key wsh authenticated, which must hash to the pod id claimed; the dialler pins the host to the pod id it meant to reach; the listener's `authorize` decides (default: nobody) | **off**; `createMeshNode({ wsh })` or an explicit transport; never in a default preference order | real wsh handshake and sealed session over an in-process pipe relay; not a browser; not a real relay deployment |

### The wsh link

Protected, between two pods that both run it:

- **Confidentiality and integrity against the relay and the network.** After the
  key exchange every byte is an authenticated encrypted frame with a strict
  counter. A frame that does not open ends the link; a plain message on a sealed
  session is dropped.
- **Peer authentication bound to the pod id**, in both directions. The
  listener refuses a login whose claimed pod id is not the hash of the key that
  signed it, and asks `authorize` (default: nobody; `createWshAuthorizer` asks
  `PeerRegistry` for `mesh:link:connect`) before any mesh frame.
- **The sender of every message on the link is the session's key.** The
  transport sets `from` to it, drops a message that names someone else
  (`foreign-sender`), and hands the pod `{ peerId }`, so the pod treats the link
  as authenticated. Pods that sign by default interoperate with it.
- **Channel binding** (the login signature covers the host key) and **least
  privilege** (the key is granted only the mesh endpoint).
- **Bounded.** Length-prefixed frames, maximum checked on the header before
  assembly; a bounded send queue over the endpoint's credit window.

Not protected: traffic analysis (who dials which rendezvous id, when, sizes and
timing; frames are not padded); the handshake before login (user name, public
key and host proof are readable by the relay, and are not secrets); a
compromised peer; availability; anything forwarded onward over a link that is
not sealed; peers that do not run it.

### Multi-hop forwarding

End to end protection ends at the pod that terminates a link. If B receives
something from A over a wsh link and sends it on to C over any other link, what
C gets is as protected as the B to C link, and B can read and change it. At the
link layer a forwarded message is distinguishable (a message naming a third
sender is dropped); at the application layer it is not: `mesh-relay`,
`mesh-rpc` and other services put the original requester inside an envelope
sent by the forwarder, and nothing marks which links on a path were sealed.

Design and threat model for wsh: [`design/wsh-peer-link.md`](design/wsh-peer-link.md).
Adopting it: [`migration-wsh-peer-link.md`](migration-wsh-peer-link.md). Usage:
the [transport README](../packages/browsermesh-transport/README.md#sealed-peer-links-over-wsh).

## Relay (`mesh-relay`)

Package: `browsermesh-apps` (`MeshRelayHost`, `createMeshRelayBackend`).

- **Authenticated / authorized.** A connection is accepted only if
  `PeerRegistry.checkAccess(peerKey, 'mesh-relay:<service>', 'connect')` allows
  it (default deny). It **ends** when that stops being true: on a registry access
  change (revocation, peer removal, permission update, `notifyAccessChange`), on
  `host.recheck()`, and on an interval (`recheckIntervalMs`, default 30000, `0`
  disables; this is how expiry is noticed). `hideService()` and `detach()` end
  the matching connections; a connect that finishes after any of these is not
  acknowledged. Both directions stop at once and the peer receives a `close`
  with a `reason` (`socket.closeReason` on the client).
- **Bounded.** Credit-based pausing per connection (window `highWaterBytes`
  262144, `lowWaterBytes` 65536); caps on unconsumed bytes per connection
  (1048576) and per peer (4194304); 16 connections per peer; 65536-byte frames.
  Exceeding a cap, or sending past the window, closes the connection with a
  reason. `host.stats()` and `backend.stats()` expose buffered and in-flight
  bytes (bytes held in the service socket's own receive window, 256 KiB per
  direction by default, are not counted). All are options; `createMeshNode({
  relayHostOptions })` passes them on. The relay host is off by default
  (`enableRelayHost`).
- **Not protected.** Relayed bytes travel as base64 in JSON envelopes and are
  readable by any peer that forwards them; there is no end-to-end encryption.
  An open connection is not re-checked per packet. Sessions accepted by
  `createMeshWebSocketService` follow the application's `onConnection` hook
  (which rejects every inbound open if none is registered) and are not
  re-checked.
- **Older peers.** An older client sends no window: it is never sent credit
  frames and cannot be paused; it is held to the byte caps and gets a `close`
  frame when a cap or a revocation ends its connection.
- **`StreamSocket` (`browsermesh-netway`).** Each direction has a receive window
  (default 256 KiB); `write()` resolves only once the peer's window has taken the
  bytes; nothing is dropped. A peer with no window is served as before.
  `close(reason)` records why on both endpoints.
- **Verified.** Unit with in-memory services (revoke mid-transfer, hide, detach,
  caps, credit); `test:real-peer` runs the relay over real WebRTC. Never in a
  browser.

## Shared servers

Package: `browsermesh-apps` (`ServerSharing`, `createProxyHandler`).

- **Authorized.** A request from a peer is served only if
  `PeerRegistry.checkAccess(peerKey, 'server-share:<name>', 'request')` allows
  it. Default deny, including with no registry. A bare `handleRequest(request)`
  with no peer is an in-process call and is not checked. Share names containing
  `:` or `*` are refused.
- **Request target.** Built from the configured origin plus a path the peer
  supplies. The path must be a plain absolute path (no scheme, authority,
  backslash, whitespace, control character, fragment, or `//` prefix) and the
  resolved URL's origin must equal the configured origin, else 400.
- **Bounded.** Redirects are not followed. Method allow-list; only allow-listed
  request headers are forwarded (`Host`, `Cookie`, `Authorization`, hop-by-hop
  headers are never taken from a peer); response `Set-Cookie` is not passed back.
  Defaults: path 2048 characters, request body 1 MiB, response 8 MiB (refused,
  not truncated), 30 s, 32 headers / 8 KiB. All are options.
- **Not protected.** Confidentiality against peers that forward the request or
  response. `createProxyHandler()` does not check who calls it; that belongs to
  whatever serves the site.
- **Verified.** Unit, against real loopback upstream servers
  (`server-sharing-target.test.mjs`, `peer-routing.test.mjs`). Never in a
  browser.

## mesh-rpc, the message channel and the protocol seam

Package: `browsermesh-apps`.

- **Caller identity.** In all three, the caller is the session key from
  `onIncomingData`, never a message field. A response is accepted only from the
  peer the request was sent to. How strong that key is depends on the link.
- **Authorization.** `mesh-rpc` and `browserMeshFetch` do none: each handler owns
  it (they expose `ctx.registry`). The message channel does none either; it
  offers `acceptPeer(from)` (default: accept all) and any peer may open a link
  until `maxPeers` (64). The **protocol seam** (`createMeshProtocolService`) does:
  `registry.checkAccess(peer, 'protocol:<name>', 'open')`, default deny (with no
  registry nothing opens and nothing is listed; an unknown and a denied name look
  the same), re-checked on every request, notification and message; an
  `authorize` option replaces the registry check. Per-method scopes are left to
  the protocol's handlers.
- **Confidential.** Not by these layers; they inherit the link (DTLS, sealed
  wsh, or nothing).
- **Bounded.** `mesh-rpc`: `requestTimeoutMs` 10000, `maxBodyBytes` 1 MiB,
  64 outgoing, 64 incoming, 8 incoming per peer (excess gets 429; an invalid or
  oversized body gets 400); cancel is honoured only from the original caller.
  Message channel and seam: `maxMessageBytes` 1 MiB, credit `window` 4 MiB,
  `chunkBytes` 16 KiB, `maxInflight` 64 per peer, `requestTimeoutMs` 30000,
  `handshakeTimeoutMs` 5000, `maxPeers` 64; a message's size is checked from its
  first chunk and a sender that overruns its credit has its link closed.
- **Options and defaults.** None of these is attached by `createMeshNode()`; each
  is opt-in (`services` / `attachService`). Channel names match
  `/^[a-z0-9][a-z0-9._-]{0,63}$/`.
- **Not built.** The remote-object layer over the seam (wsh-objects), streams
  larger than one message, a capability advertisement in discovery, per-root
  authorization helpers.
- **Verified.** `mesh-rpc`/`browserMeshFetch`: unit, and echo/404 routing over a
  real WebRTC data channel in two browsers (the harness node has no registry or
  identity, so authorization is not exercised there). Message channel and seam:
  unit and in-memory duplex only; never over real WebRTC or in a browser.
- **Registry.** `PeerRegistry.checkAccess` is default deny (`not_in_roster`,
  `scope_denied`, `entry_expired`, `capability_revoked`); the only bypass is the
  local owner. `grant-log` replicates signed grant records (Ed25519,
  self-verifying pod ids, authorization replayed deterministically; `at` is
  caller-supplied, revoking an admin is not retroactive). The audit chain
  (hash-linked, signed per entry) is off unless `enableAudit`. Unit only.

## Sync

Package: `browsermesh-sync`.

- **Authenticated.** CRDT and delta updates are not signed, encrypted or
  authorized: `merge()` deserializes and merges what it is given. A document's
  `acl` and `owner` fields are stored but not consulted on merge. The
  `trust` conflict strategy uses a caller-supplied score keyed by a
  self-declared pod id.
- **Integrity.** File chunks are content-addressed (SHA-256 hex by default;
  `format: 'cidv1'` is opt-in) and a received chunk whose hash does not match is
  refused. There is no sender authentication or encryption.
- **Bounded.** Chunk size 256 KiB, 16 concurrent chunks, offer expiry 5 minutes.
  No cap on total transfer size (the offer's `totalSize` is the sender's), and
  `DeltaLog` has no size limit by default.
- **Replicated stores in `browsermesh-apps`** add checks on top: `mesh-kv`
  accepts a remote write only if its node id equals the sender's key and
  `checkAccess(writer, 'kv:<id>', 'write')` allows it (read/admin are not
  enforced per message, no encryption); cloud storage encrypts at rest and gates
  manifest sync; `peer-encrypted-store` stores ciphertext only.
- **Verified.** Unit (IndexedDB with `fake-indexeddb`); CRDT convergence over a
  real data channel in two real browsers.

## Discovery and StealthAgent

Package: `browsermesh-discovery`.

- **DHT.** `DhtNode` has a routing table and answers `ping`, `findNode`,
  `findValue` and `store`, but there is no iterative lookup: `findNode` and
  `findValue` return the local routing-table closest set, `store` writes locally
  and sends to the local closest contacts, and nothing follows responses.
  Distance is computed over character codes, not a 160-bit hash. A `store` is
  accepted for any key with no signature or ownership check and no entry cap
  (`k` = 20 per bucket; TTL optional, default none). Tests are single-process.
- **Announcements.** Discovery records are unsigned. `RelayStrategy` accepts an
  optional `signFn` (off by default; checking is the server's job). Names
  (`MeshNameResolver`) are first-come-first-served, at most 64 characters, 1 h
  default TTL, unsigned. Swarm membership and leader election are
  unauthenticated. `mesh-dht` in `browsermesh-apps` does not authenticate DHT
  messages either.
- **StealthAgent.** The plain `hide()` / `reconstitute()` path is **not
  encrypted and not anonymous**: `threshold` plaintext shards plus XOR parity,
  a checksum that detects corruption but not tampering (defaults 3 of 5). With
  `key` (`deriveStealthKey`: HKDF-SHA-256 then AES-256-GCM, agent id as AAD) or a
  `keyring` (key ids with rotation, sequence and issue-time replay refusal,
  optional `maxAgeMs` default unset, seal budget 2^32) the shards are encrypted
  (off by default). Not done: signed shards, anonymous DHT keys, multi-loss
  parity; any group-key holder can read and forge state. Threshold key sharing is
  design only (`design/stealth-threshold.md`, issue #230).
- **Verified.** Unit, with in-process nodes and a no-op send function. Never over
  a network or in a browser.

## Hosted pods, per lane

Detailed review with the tests that pin each denial and the list of what is not
defended: [`design/hosted-pods-security-review.md`](design/hosted-pods-security-review.md).
Summary:

| Lane | Runs requester code | Boundary | What a pod can reach | Verified |
| --- | --- | --- | --- | --- |
| microVM (Firecracker, `spikes/vm-pod-host`) | yes | hardware (KVM), jailer, cgroups, per-pod network policy | own disk copy only; no host environment; default-deny per-pod network policy (private, loopback, link-local and metadata addresses dropped; no host or other-guest access); distinct VMM uid per VM | unit against fakes; the jail, the nft rules and the guest have **never been run on a real host** (`test:real-firecracker` exists and has never run) |
| node permission-model process | modules from the host's catalog only | `process` (not a sandbox) | read of the entry file, module and catalog `readPaths`; no write, network or process creation; only the podspec's environment | unit, including denied-access tests |
| node `worker_threads` | catalog modules | `none` | **everything the host can**: files, network, processes, memory (asserted by a test so documentation cannot drift) | unit |
| isolate (Worker / Durable Object spike) | **no**: runs a fixed echo pod | V8 isolate | the Worker's bindings and storage (which holds the pod key); control routes loopback-only with an optional bearer token | unit; no deployment |
| isolate, `isolated-vm` (`createIsolatedVmRuntime()`, optional dependency) | modules from the host's catalog only | language, **in the host's own process** | no `require`, `process`, filesystem, network, timers or `WebAssembly`; one frozen context (`name`, `env`, `input`, `log`); only JSON strings and one log callback cross; heap and per-call time limits that dispose the isolate and report `oom` or `timeout`. A V8 or `isolated-vm` memory-safety bug is a bug in the host process (it can reach everything the host can); the heap limit is a guideline (2 to 3 times is possible); there is no cumulative CPU budget | unit, including escape tests (constructor chains, prototype walks, thenables, re-entrancy, memory and CPU exhaustion); never against a real V8 exploit |
| isolate `workerd` | specified only | language | not built | never |
| browser in-page / CDP / extension | yes (a page) | tab / browser context / extension world | in-page: no sandbox attribute, a same-origin pod shares the parent's storage; CDP: the browser's network position; extension: the extension's permissions | unit and fakes; one e2e with headless Chrome for CDP |

Across lanes: scopes are per resource, not per pod (a requester granted `drain`,
`exec` or `send` can use it on any pod under that resource); `env` values and
`run.input` are shown only to the requester that spawned the pod; `describe()`
is ungated; placement refuses an untrusted requester on a weak boundary. Not
defended: hypervisor, kernel and V8 vulnerabilities, side channels, the host
operator (who can read guest memory, snapshots and keys), restoring one snapshot
twice (two pods, one identity), resource exhaustion beyond configured limits.

## What is verified how

| Layer | unit | duplex / in-memory | real peer | real browser (CI) | never |
| --- | --- | --- | --- | --- | --- |
| Identity | yes | | | generate, sign, verify | handshake token with a real signaling server |
| Pod messages | yes | | | BroadcastChannel (and cross-origin invisibility), WebSocket relay (test double) | real `browsermesh-servers` |
| BroadcastChannel / WebSocket links | yes | | | yes | |
| WebRTC channel | yes | | yes | yes (loopback, no STUN) | NAT traversal, TURN |
| WebRTC identity binding | yes | yes (fake peer connections) | | | a real `RTCPeerConnection` (issue #270) |
| wsh link | yes | in-process pipe relay, real wsh sessions | | | browser, real relay |
| WebTransport, wisp, relay client | mocks | | | | real servers |
| Relay | yes | in-memory services | yes | | browser |
| Shared servers | yes (real loopback upstreams) | | | | browser |
| mesh-rpc / `browserMeshFetch` | yes | JSON-boundary network | | echo and 404 over a data channel | with a registry and identity in a browser |
| Message channel, protocol seam | yes | in-memory duplex | | | real WebRTC, browser |
| Sync | yes | | | CRDT convergence over a data channel | file transfer over a real link |
| Discovery, DHT, StealthAgent | yes | | | | any network |
| Hosted pods | yes (fakes) | | | | real microVM, Firecracker host, `workerd`; `isolated-vm` against a real V8 exploit |

Not verified anywhere here: anything needing STUN/TURN or a non-loopback
network, the real `browsermesh-servers` relay and signaling, service workers,
GPU and IndexedDB in a real browser. The WebKit CI job is allowed to fail.
