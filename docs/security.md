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
- **real peer**: `npm run test:real-peer`, a native WebRTC binding in Node; also
  the signalling-server suites, which start the real `browsermesh-servers`
  signalling server as a child process on loopback and skip, with a stated
  reason, where that checkout is absent.
- **real browser**: `npm run test:browser` (Playwright, strict CSP; Chromium, Firefox and WebKit run in CI,
  and all three are required checks). The relay and
  signaling servers there are in-repo test doubles. See `tests/browser/README.md`.
- **never**: not exercised by any test.

## Implementation status per package

Classes: **implemented** (real code and tests that exercise it), **partial**
(real code with stated gaps, stubs, or only mocked tests), **spec only**
(design or comments, or throws not-implemented). Per-module notes follow the
table; they come from the READMEs, source headers and test directories.

| Package | Status | Notes |
| --- | --- | --- |
| `browsermesh-primitives` | implemented | identity, session certificates, signed key-agreement statements and sealing (X25519, HKDF, AES-GCM), wire format, CRDTs, ACL, capability scopes, trust graph, padding. Unit tests; identity and sealing also in a real browser. Trust edges are unsigned. Session certificates are not wired into the handshake or any transport. |
| `browsermesh-core` | implemented, with partial modules | identity managers and vault storage, keyring, capability tokens, group keys, ACL, trust: implemented (unit). `handshake.mjs`: partial (connection token is unsigned and the pod id is not checked against the key; mock transports). `hardening.mjs` and `peer.mjs`: marked experimental in source. `compat.mjs`: shim whose `BrowserTool#execute()` throws not-implemented by design. |
| `browsermesh-pod` | implemented | pod, messaging and signing, discovery, host protocol, runtimes (worker_threads, permission-model), `WebSocketTransport` and BroadcastChannel transports (unit and real browser). `browser-host-driver`: partial (`exec` is deliberately not offered in the browser lane; `snapshot` and `restore` not implemented). |
| `browsermesh-transport` | implemented, with partial modules | WebSocket, WebRTC (unit, real peer, real browser); wsh links (real wsh handshake over an in-process relay; not a browser); identity binding (duplex, real peer, real browser). WebTransport, relay client, wisp (mocks only). `channel-relay`, `gateway`, `cross-origin`, `streams` (unit). `NATTraversal` in `websocket.mjs`: placeholder values, partial. |
| `browsermesh-apps` | implemented, with partial modules | registry, grant log, audit, mesh-rpc, mesh-fetch, message channel, protocol seam, relay host and backend, sync, cloud storage, key distribution, KV, escrow, pod-host service, placement, supervisor: implemented (mostly in process; a few over real peers). Partial: `mesh-bootstrap` (one real-peer test file), torrent (single-process fallback; real WebTorrent only under `test/real-torrent`), `peer-ipfs` (a local SHA-256 store, not IPFS), `peer-terminal` (no default shell), serverless executors (not an adversarial sandbox), GPU (real WebGPU only in a dedicated test), `mesh-dht` (no authentication), `compat.mjs`. `wsh-objects` (built in wsh, not here) runs over the protocol seam in `examples/19` and its test, an example-only dependency. |
| `browsermesh-sync` | implemented, with partial modules | CRDT, delta sync, memory sync, file chunks, CIDv1, IndexedDB storage (unit, `fake-indexeddb`); CRDT convergence also over a real data channel in a browser. `collab` and `collab-bridge`: partial (marked experimental; stub document when Yjs is absent). |
| `browsermesh-discovery` | partial | DHT has no iterative lookup (below); discovery strategies unsigned; naming, swarm, service-worker routing implemented (unit, unauthenticated); StealthAgent plain path documented as plaintext, encrypted/keyring path implemented; threshold key sharing is spec only (`docs/design/stealth-threshold.md`). |
| `browsermesh-netway` | implemented | loopback, virtual network, policy, queue, sockets (byte-level backpressure), listener, router, service and fs backends, chaos wrapper (unit). `gateway-backend`: partial (mock wsh transport only). `backend.mjs`: abstract base. |
| `browsermesh-kernel` | implemented | in-process microkernel with capability checks and resource tables; unit tests per module. No cryptography; isolation is by capability and ownership checks, not process boundaries. |
| `browsermesh-priority-mux` | implemented | sender-side priority scheduler and framer (fake adapter tests). No authentication or encryption. The reassembler has no limit on pending messages. |
| `browsermesh-embed` | partial | widget wrapper tested against a DOM stub only. |
| `browsermesh-meshctl` | partial | loopback mode exercised through all eight verbs; the real-mesh path is wired, not exercised end to end; `--relay` is not load-bearing. |
| `spikes/*` | spikes | `vm-pod-host` (Firecracker driver: never booted a VM), `isolate-pod-host`, `browser-pod-host`, `browser-extension-host`; see [hosted pods](#hosted-pods-per-lane). |

Facts that can be read from the tree are generated and checked by
`npm test` (`scripts/status-facts.mjs`, `scripts/status-facts.test.mjs`): the
whether the package is published, the entry points of each `package.json`,
whether it has unit tests, native-peer tests (`test/real-peer/`) and real-browser
tests (named under `tests/browser/`). Versions are not listed: the release
workflow bumps them in a pull request of its own. The test also fails when a
package has no row in the table above or a row names no package. After a change
that alters these facts (a new entry point, a new test suite), run `node
scripts/status-facts.mjs --write`. The judgement in the table above stays
hand-written.

<!-- status-facts:begin (generated by scripts/status-facts.mjs; do not edit by hand) -->
| Package | Published | Entry points | Unit tests | Real-peer tests | Real-browser tests |
| --- | --- | --- | --- | --- | --- |
| `browsermesh-apps` | yes | `.` `./compat` `./mesh-rpc` `./mesh-channel` `./protocol-channel` `./protocol-stream` `./protocol-roots` `./channel-advertisement` `./mesh-fetch` `./mesh-service` `./peer-registry` | yes | yes | yes |
| `browsermesh-core` | yes | `.` `./compat` | yes | yes | no |
| `browsermesh-discovery` | yes | `.` | yes | no | no |
| `browsermesh-embed` | yes | `.` | yes | no | no |
| `browsermesh-kernel` | yes | `.` | yes | no | no |
| `browsermesh-meshctl` | private | `.` | yes | no | no |
| `browsermesh-netway` | yes | `.` | yes | no | no |
| `browsermesh-pod` | yes | `.` `./node-runtimes` | yes | yes | yes |
| `browsermesh-primitives` | yes | `.` | yes | no | yes |
| `browsermesh-priority-mux` | yes | `.` | yes | no | no |
| `browsermesh-sync` | yes | `.` | yes | no | yes |
| `browsermesh-transport` | yes | `.` `./wsh-in-process` | yes | yes | yes |
<!-- status-facts:end -->

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
- **Discovery messages.** `pod:hello`, `pod:hello-ack` and `pod:goodbye` are
  signed with the same scheme and counter. A peer list entry exists only for a
  key that proved itself (the pod id a hello names must be the hash of the key
  that signed it) and is marked `authenticated: true`; a goodbye removes only the
  peer it names, only for the session that said hello, and an unsigned goodbye
  never removes an entry a signature proved. A link that authenticates its peer
  stands in for the signature (`WshPodTransport` hands over a goodbye under the
  link's identity when the link goes down). What a relay or signalling server
  says about who is connected (`peers`, `peer-joined`, `peer-left`, a relayed
  frame's `source`) is a hint of whom to greet, never membership:
  `WebSocketTransport` sends a hello to a hinted pod and any other broadcast
  only to pods whose signed hello or ack verified. Pods on 0.2.0 send unsigned
  hellos: admitted only where `allowUnsigned` allows (default: same-origin
  transports and the window; refused over a relay or a custom adapter), listed
  with `authenticated: false`.
- **Window channel.** A pod listens to **no window by default**: a `message`
  event is refused (`window-source`) unless it matches the `window` boot option
  (`sources`: exact Window objects compared with `event.source`; `parent: true`;
  `origins`: exact origins compared with `event.origin`), every constraint given
  having to match. What an accepted window sends unsigned is delivered with
  `authenticated: false` (refused with `allowUnsigned: false`); a signature must
  verify either way. Only the configured parent can answer the parent
  handshake, and the child's hello is posted to the configured origin.
- **Bounded.** Replay window of the last 64 sequence numbers per sender session;
  4 sessions per sender, 1024 senders, in memory. Drops are counted in
  `pod.dropped` by reason (`unsigned`, `unsigned-rpc`, `malformed`,
  `sender-mismatch`, `bad-signature`, `replay`) and emitted as `message:dropped`.
- **Options and defaults.** `sign` (default `true`). `allowUnsigned`: default
  `true` only for transports that declare `trust === 'same-origin'`
  (`BroadcastChannelTransport`, `EventEmitterTransport`, `NullTransport`) and
  for messages from a window the pod was told to listen to; `false` for `WebSocketTransport` and for any custom
  adapter that does not declare `trust`. An unsigned `pod:rpc-request` is never
  accepted. `send()` and `broadcast()` return promises.
- **Not protected.** Confidentiality: a signed message is readable by the relay
  and by every peer that forwards it. A relay can drop or delay messages.
  Replay state is in memory: a copy from a session the receiver forgot, or sent
  after the receiver restarted, is not recognised. Same-origin delivery trusts
  the origin: any script of the origin can post under any pod id, and announce
  or retire a pod. A signed hello proves that the key spoke at some time, not
  that it is online now (a relay can replay one the receiver has forgotten).
  Routed envelopes are covered in [multi-hop forwarding](#multi-hop-forwarding).
- **Verified.** Unit (`message-authenticity.test.mjs`, with a hostile relay,
  fixed vectors and each signed field shown to be covered); real browser for
  messaging over BroadcastChannel and over the WebSocket relay (signed by
  default). The window channel: unit with fake `MessageEvent`s
  (`window-channel.test.mjs`) and real browser with a top page and three frames
  on two origins (`tests/browser/window-channel.spec.mjs`).

## Peer links by transport

| Link | Encrypted against the network | Encrypted against a relay | Who the peer is, as far as this code checks | On by default | Verified |
| --- | --- | --- | --- | --- | --- |
| `BroadcastChannelTransport` (pod) | the browser's same-origin isolation | no relay | any same-origin context on that channel name | yes (pod default) | unit; real browser (also across two origins: invisible) |
| `WebSocketTransport` (pod, relay protocol) | TLS only if the URL is `wss://` | **no**: the relay reads every envelope | pod messages and discovery messages are signed (see above); the relay's `source` and its peer lists are hints, not membership, and are not believed; the relay dialect's `register` frame sends no proof of key. With the signalling dialect and an `identity`, the registration is signed for the server (see [signalling registration](#signalling-server-registration-protocol-2)) | pods sign by default; `allowUnsigned` false here; the signed registration is used when the server offers it and an `identity` is given | unit; real browser against a test-double relay; signalling registration also against the real server (opt-in real-peer, where its checkout is present) |
| `WebSocketTransport` / `WebTransportTransport` (transport package) | as above | no | none by the transport itself; optional `padding` and `jitterMs` hide sizes and timing from a network observer, not from the relay | padding and jitter off | WebSocket: unit and real browser (text, 1 MiB binary); WebTransport: mock only |
| WebRTC (`WebRTCPeerConnection`, `WebRTCMeshManager`) | DTLS (standard data channel encryption) | the signaling relay carries offers and answers, including DTLS fingerprints | signaling names the peer's pod id. With `identity` set, each side proves possession of its pod key over both descriptions' DTLS fingerprints (a swapped description is detected, the connection is closed); a peer sending no proof is closed after `bindingTimeoutMs` (10 s) unless `requirePeerBinding: false`. A renegotiation whose fingerprint changes is rejected | **`createMeshNode()` wires the node identity in: binding on, peer proof required** (`webrtcIdentityBinding: false` turns it off; `webrtcAllowUnboundPeers: true` is the opt-out for peers on transport older than 0.6.0, which send no proof and are otherwise closed after the timeout with reason `timeout`: the caller's `connectToPeer()` rejects with it and the node emits `peer:binding-failed`). A bare `WebRTCMeshManager` is unbound unless given `identity` | DTLS channel: unit, real peer, real browser. Binding: duplex, real peer (node-datachannel, `createMeshNode`), and real browser (Chromium, Firefox) incl. a signalling server that swaps the descriptions |
| **wsh link** (`WshPeerLinks`, `WshPodTransport`) | sealed end to end (authenticated encryption, X25519 + ML-KEM-768) | **sealed: ciphertext only** | the key wsh authenticated, which must hash to the pod id claimed; the dialler pins the host to the pod id it meant to reach; the listener's `authorize` decides (default: nobody) | **off**; `createMeshNode({ wsh })` or an explicit transport; never in a default preference order | real wsh handshake and sealed session over an in-process pipe relay; not a browser; not a real relay deployment |

### Signalling server registration (protocol 2)

The signalling server (`browsermesh-servers/signaling`) runs in one of two
modes. In **open** mode any pod id is accepted: nothing proves who a client is,
so the server stamps every peer `verified: false` (and `sourceVerified: false`
on each forwarded message). In **authenticated** mode (protocol 2) the server
sends each connection a single-use challenge, and a client registers only by
signing it: the pod id must be the hash of the Ed25519 key that signs, and the
signature covers the server's own origin, the pod id and the nonce, so a proof
cannot be replayed on another connection or relayed to another server. A client
that does not speak protocol 2 is refused with `protocol-unsupported`.

What the clients here do:

- `WebSocketTransport` (pod, signalling dialect and the `signalingUrl`
  connection) and `SignalingClient` (core) take an `identity`. With one, they
  answer a challenge with a signature over the origin of the URL they were
  configured with (never the origin the challenge names; `origin` overrides it
  for a server reached under another name), and against an open-mode or older
  server, which sends no challenge, they register as before after a bounded wait
  (`challengeWaitMs`). `authentication: 'required'` never falls back; `'off'`
  never signs. Without an identity, against an authenticated server, they fail
  with a named `SignalingAuthRequiredError` and do not retry.
- A verified pod may hold more than one connection (server `MAX_CONNECTIONS_PER_POD`,
  default 2; messages go to the newest). A displaced connection is told
  `replaced` (`reconnect: false`, close 4409) and the clients stay down and
  report it (`onReplaced`, the `replaced` event) rather than reconnect and
  displace another in turn; an open-mode server still refuses a second
  connection for an id.
- What the server says is a statement about the link, not about the peer:
  `serverVerifiedPeers` and `relaySourceVerified` (pod) and `isSourceVerified()`
  (core) report the server's stamp, true only for a literal `true` set by the
  server. A server-verified pod is still a hint: it is not a broadcast recipient
  (`verifiedPeers` still requires the pod's own signed hello or ack), and an
  attacker who can strip the challenge from an unprotected (`ws://`) link can
  push an `auto` client into the open flow, which `registration` reports as
  `{ mode: 'open', verified: false }`. Use `wss://` and `'required'` where that
  matters.
- `GET /ice-servers` needs `Authorization: Bearer <token>` or a same-origin
  caller. `fetchIceServers({ url | signalingUrl, token })` (core) sends the token
  as a header only, refuses to send it over plain `http` to a non-loopback host,
  and never follows a redirect with it.

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

### wsh services on a pod

Package: `browsermesh-transport` (`WshServices`, `wsh-services.mjs`). Design:
[`design/wsh-services-on-a-pod.md`](design/wsh-services-on-a-pod.md). A stock wsh client
(`wsh`, `wsh-mcp`, `WshClient`) may use a pod's **objects** and **MCP tools**. **Off:**
nothing in the repository constructs it; a pod that does not call `new WshServices(...).start()`
has nothing listening at the services rendezvous id, and `start()` refuses unless the embedder
gives an indicator or says `unattended: true`.

- **Who may log in.** A key whose pod id (the hash of the key wsh authenticated) holds the
  registry grant `wsh-services:open`. Nothing in a key line, an `authorized_keys` option or a
  capability string is consulted (the host has no `authorizedKeys`), the user name is a label, and
  an unknown key is refused at login, before any channel exists. A mesh grant (`mesh:link:connect`)
  is not a services grant. The session is sealed (`sealSession: 'require'`, login bound to the host
  key); the host key is the pod key, so a client pins the pod by its pod id; a plain client is served
  nothing.
- **What it can reach.** Only the two rpc channels `mcp` and `wsh-objects`, each needing its channel
  grant (`protocol:mcp:open`, `protocol:objects:open`), then per request `mcp:<tool>:list|call` and
  `objects:<root>:get|call|set|on` from the registry, on top of the page's own allow-lists. The host
  is a memory host given nothing else: no exec, pty, files, targets, endpoints or gateway exist on
  it, and the tests assert each is refused and that the features it states are the sealing and the
  two protocols only. The same grant strings as the mesh uses, so one set of grants per pod id.
- **Revocation and expiry.** Asked on every request; the registry's access-change event (revoke,
  remove, update, expiry) ends the session of a pod that lost `wsh-services:open` (the client is told
  why first), and a revoked channel grant closes that channel.
- **The page decides.** A consequential tool asks the pod's own `prompt`; the wsh client cannot
  answer it. The embedder's `indicator` is told of each session and can stop it (and refuse that key
  until restart); `maxSessions` (4) bounds sessions; the tool bridge's and the object layer's limits
  apply; every session and refusal is an audit event naming the pod id.
- **Not protected.** A key that holds grants can do what they say (a key hash is not a person); a
  tool or an object path does what it does with the page user's session; the relay sees who dials
  which rendezvous id and when (an impostor can occupy a waiting slot, not become the pod). Whether
  the released CLIs can dial a pipe relay URL is wsh's matter: the tests use the JavaScript
  `WshClient`.
- **Verified.** Unit, with the real `WshClient` over the in-process pipe relay (allowed and refused
  keys, a grant limited to one root and one tool, revocation mid-session, default off, nothing but
  objects and MCP, each rule broken once); with the real `PeerRegistry` (`browsermesh-apps`
  `test/wsh-services.test.mjs`). Not in a browser; the released CLIs were not run.

### Multi-hop forwarding

End to end protection ends at the pod that terminates a link. If B receives
something from A over a wsh link and sends it on to C over any other link, what
C gets is as protected as the B to C link, and B can read it. At the link layer
a forwarded message is distinguishable (a message naming a third sender is
dropped).

**Routed envelopes** (`MeshRouter`, `createMeshRoutingService` in
`browsermesh-apps`) carry the **originator's signature**: a `pod:message`
signature (the pod message scheme above) from the originator to the final
recipient over `{ kind: 'mesh-routed/v1', id, message }`, so it covers the
originator, the final recipient, the message id, the content, and the signer's
session id and counter. The final recipient verifies it and refuses a copy it
already accepted; every forwarding hop verifies it too and drops what does not
verify (event `mesh-routing:drop`, reasons `unsigned`, `malformed`,
`wrong-recipient`, `sender-mismatch`, `bad-signature`, `replay`, `no-link`,
`sign-failed`). A hop may append itself to `path` and lowers `ttl`, which are
not signed: `path` is a diagnostic hint, bounded to 32 entries and used for
nothing, and `ttl` is clamped to the router's own `maxTTL`. A hop forwards
only for a peer it has a link with (`hasActiveSession`). After this, **a hop
cannot forge or alter a routed message's content, origin or recipient. It can
still drop, delay and reorder it, and, unless the message is sealed (next
paragraph), read it.** Per-hop sealing exists where a link is a wsh link.
Default: signed, and unsigned envelopes from older peers are refused unless
`allowUnsigned: true` (then delivered with `authenticated: false`, their `from`
only a claim). Replay state at the recipient is in memory and bounded like the
pod's. Not covered: other services that wrap a requester inside an envelope the
forwarder sends (`mesh-relay`, `mesh-rpc` and the like) still name the original
requester only as the forwarder says, and nothing marks which links on a path
were sealed.

**End-to-end sealing of routed messages** (on by default for a node that can
sign and whose runtime has X25519; `sealing: false` turns it off). A message
to a pod whose current key statement this pod holds is sealed to that pod:

- *Key statement.* A pod id is a hash, so an encryption key has to be bound to
  it by a signature. A statement is `{ podId, pk, ka, kid, notBefore, notAfter,
  sig }`: an X25519 key `ka` signed by the Ed25519 key `pk` whose hash is
  `podId`. A receiver checks the hash, the signature, the dates (at most 24 h,
  default 2 h, 30 s of skew before `notBefore`, none after `notAfter`) and that
  the identity has not been retired in the revocation store the session
  certificates use (`sealingOptions.revocations`; a store that cannot answer
  counts as revoked), before it caches it. A pod makes a new key and statement
  after an hour (lazily, at next use) and deletes a private key when its
  statement expires.
- *Where statements travel.* On the direct link, when a peer is added with
  `addDirectPeer()` (`mesh-routing-keys` envelope, answered once); on demand
  through a routed request (`ensureKey(podId)`, `{ $mesh: 'key-request' }` and
  `{ $mesh: 'key-statement' }`, signed like any routed message; a request goes
  out at most once a minute per pod).
- *Seal if the destination can.* When sealing is on and the destination's
  statement is not cached, `route()` does not send the message yet. It starts
  the fetch above, queues the message (at most 16 per destination, option
  `maxQueuedPerDestination`; the overflow is dropped as `sealed-unavailable`
  and is never sent readable) and waits at most `sealingOptions.keyWaitMs`
  (default 2 s). If a valid statement arrives the message is sealed and sent.
  If none arrives, the destination is treated as not supporting sealing for
  `negativeCacheMs` (default 60 s, so later messages are not each delayed), the
  message goes out as the signed readable envelope, and the sender's service
  emits `mesh-routing:sealed-fallback` (`{ from, to, reason }`) for each message
  sent that way; the delivery reports `sealed: false`. A message to a pod
  that has been asked again after the negative cache ran out waits again. The
  wait does not delay `requireSealed` sends, which fail at once when no
  statement is cached.
- *The seal.* Ephemeral-static X25519: a fresh key pair per message, HKDF-SHA-256
  (salt: ephemeral key and `ka`) to an AES-256-GCM key, a random 12-byte nonce;
  the associated data is `["browsermesh/routed-seal/v1", from, to, id]`. The
  signed payload becomes `{ kind: 'mesh-routed/v1', id, message: null, sealed:
  { v, kid, epk, iv, ct } }` and the originator signs that as before, so the
  signature covers the ciphertext and the session counter and hops verify
  origin without reading content. Replay protection at the recipient is
  unchanged. A message may be at most 64 KiB sealed (`sealed-too-large`
  otherwise, never sent readable instead).
- *Delivery.* The message event carries `sealed: true | false` next to
  `authenticated`.
- *Negotiation.* There is no flag to turn on in a message: a pod that
  publishes a statement can open sealed messages, and a pod that has not
  published one (or whose statement does not arrive in time) is sent the
  readable envelope it understands. `requireSealed:
  true` on the service, or on a single `route()`, refuses to send what cannot
  be sealed with the statements already cached (it does not wait; call
  `await api.ensureKey(podId)` first to fetch one) (`SealedUnavailableError`, code `E_SEALED_UNAVAILABLE`, and a
  `drop` event, reason `sealed-unavailable`); as a service option it also
  refuses, as destination, a readable envelope (`drop`, reason `unsealed`).
  Other drops: `bad-seal`, `sealed-unsupported`, `sealed-too-large`.

Protected for a sealed envelope: **confidentiality and integrity of the content
against every hop and against anyone who can read the links**, and the
originator, recipient, id and counter are bound to the ciphertext (a box cannot
be moved to another message or sent under another name). Still visible to hops:
the originator, the recipient, the message id, the size (to within the AEAD
overhead), the timing and the path. Hops can still **drop, delay and reorder**.
**A hop that suppresses key statements (drops the request or the answer) can
still force the readable fallback**: the sender waits `keyWaitMs`, then sends
the message readable to that same hop. The fallback is visible to the sender
(`mesh-routing:sealed-fallback`) and to the receiver (`sealed: false`), not
prevented. `requireSealed` is the control against it: the send is refused with
`SealedUnavailableError`, and a destination with `requireSealed` refuses a
readable envelope. A statement that has been learned (from the direct link, or
from an earlier answer) is used until it expires, so suppression only matters
before the first statement and after expiry or rotation.

Forward secrecy, exactly: the sender's ephemeral key is discarded, so
compromising the sender later reveals nothing it sealed. The recipient's agreement
key is not ephemeral: whoever obtains it (and a recording of the traffic) opens
everything sealed to it until it was deleted, which is at most one statement
lifetime after rotation. There is no per-message forward secrecy against the
recipient and no post-compromise recovery beyond rotation. A statement is
authentic only as far as the identity key is: nothing here detects a compromised
identity key, and a retired identity is refused only where the revocation
reached.

Older peers: an apps 0.19.0 hop verifies a sealed envelope (its kind and
signature are unchanged), rebuilds the top level from the signed fields,
finds `message: null`, and forwards it with the signature; the destination
opens it. An older destination is never sealed to (it publishes no
statement). A sealed envelope that an older destination somehow received would
be delivered with `message: null`, which is why a sender seals only to a pod
that published a statement. The design and the options not taken are in
[`design/routed-confidentiality.md`](design/routed-confidentiality.md).

Design and threat model for wsh: [`design/wsh-peer-link.md`](design/wsh-peer-link.md).
Adopting it: [`migration-wsh-peer-link.md`](migration-wsh-peer-link.md). Usage:
the [transport README](../packages/browsermesh-transport/README.md#sealed-peer-links-over-wsh).

## Relay (`mesh-relay`)

Package: `browsermesh-apps` (`MeshRelayHost`, `createMeshRelayBackend`).

- **Authenticated / authorized.** A connection is accepted only if
  `PeerRegistry.checkAccess(peerKey, 'mesh-relay:<service>', 'connect')` allows
  it (default deny). It **ends** when that stops being true: on a registry access
  change (revocation, peer removal, permission update, a grant that expired,
  `notifyAccessChange`), on `host.recheck()`, and on an interval
  (`recheckIntervalMs`, default 30000, `0` disables; a backstop now that expiry is
  announced). `hideService()` and `detach()` end
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
  An open connection is not re-checked per packet.
- **Long-lived holders of a grant.** Anything that stays open after a
  `checkAccess()` follows the registry's access-change events (revocation,
  removal, permission update, an expired grant) instead of waiting for its next
  use: `createMeshWebSocketService` sessions are checked again (`accessResource`
  or the `onConnection` hook, closed with 4403 `access revoked`);
  open protocol channels (`createMeshProtocolService`) are closed; swarm members
  admitted through the join gate are removed; a default-authorised wsh link
  (`createMeshNode({ wsh })`) is closed (`watchWshAccess`); torrent serving
  decides again after a rate-limit wait. Per-operation checks (rpc, files, kv,
  chunk replication, escrow, terminal, orchestrator, compute) hold nothing open.
  A custom `authorize` hook on a wsh link, or on the torrent service, is the
  caller's to enforce. A roster entry given an `expires` directly on an injected
  `MeshACL` is not tracked (call `notifyAccessChange`).
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
  response.
- **`createProxyHandler()`** throws at construction unless it is given a
  `checkAccess` (called as `checkAccess(fromPubKey, resource, 'request')`, resource
  default `serverless-proxy:<host>`) or `public: true`; a caller that names no key
  is never allowed (403), and a throw denies.
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
  `authorize` option replaces the registry check. **Per-root authorisation**
  (`createRootAuthorizer`, or `service.api.rootAuthorizer(protocol)` backed by
  the node's registry): the scope `<protocol>:<root>:<action>` (for example
  `objects:docs:get`) through `checkAccess`, default deny, the registry's
  wildcards and expiry, asked about the channel's verified peer on every
  request a `guard()`ed handler receives; root and action names cannot carry
  scope syntax. An already-open stream or subscription is authorised when it
  starts, not again. Anything finer than a root is left to the protocol's
  handlers.
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
- **Streams.** `createStreamLayer(channel)` (`protocol-stream.mjs`) carries a
  body larger than one message over any protocol channel: a per-stream byte
  `window` (default 256 KiB) the receiver grants and the reader returns as it
  consumes, so a reader that stops reading stops the writer at one window and
  the receiver never holds more than a window of a stream; `maxStreams` 16 per
  direction, `maxStreamBytes` 1 GiB; either end or an `AbortSignal` cancels. A
  writer that ignores its credit, sends out of sequence or past the limit is cut
  off (`stream-violation`, `stream-too-large`). The caller supplies
  `authorize(meta, { peer })`, run before the open is answered. A stalled stream
  holds neither the link nor other requests on the channel (stream frames are
  notifications, whose link credit is returned at dispatch).
- **Not built.** The remote-object layer lives in wsh (`@johnhenry/wsh/objects`,
  not a dependency of any package here); it runs over the seam in
  `examples/19-wsh-objects-over-protocol-channel.mjs` and
  `test/wsh-objects-over-channel.test.mjs`, authorised per root through
  `createRootAuthorizer` (`objects:<root>:<action>`, for the channel's verified peer).
- **Verified.** `mesh-rpc`/`browserMeshFetch`: unit, and echo/404 routing over a
  real WebRTC data channel in two browsers (the harness node has no registry or
  identity, so authorization is not exercised there). Message channel and seam:
  unit and in-memory duplex, and over a real WebRTC data channel in two
  browsers (`tests/browser/protocol-channel.spec.mjs`: default deny, the open
  scope, the verified peer seen by handlers, a 900 KB binary result chunked
  across messages, progress, notifications, cancel, revocation closing the
  channel at once, and a reader that stops reading holding the sender at one
  window). Streams and root authorisation: unit, in-memory duplex and the real
  mesh channel in process; not yet over real WebRTC in a browser.
- **Identifiers.** An id that matches a response to a request (rpc, proxy,
  dispatch, join, submit, witness, chunk, escrow, hosted-pod verbs) or names a
  connection (`mesh-websocket`, `mesh-relay`, wire streams) is 128 random bits
  from `crypto.getRandomValues`, with no `Math.random` fallback: where the
  platform has no CSPRNG, creating the id throws. A response is accepted only from
  the peer the request was sent to, and a connection id only from the peer at
  the other end; the id alone proves nothing. Escrow contract ids are random too
  (`escrow:<id>` is an ACL resource a peer can name). Ids that are only local
  labels, or entity ids no peer names on the wire (ledger entries, chat
  message ids, proposal ids), are still clock-and-counter and are listed in the
  pull request that introduced this.
- **Registry.** `PeerRegistry.checkAccess` is default deny (`not_in_roster`,
  `scope_denied`, `entry_expired`, `capability_revoked`); the only bypass is the
  local owner. Scopes are matched segment by segment, for any number of segments,
  by one matcher (`matchScope` in `browsermesh-primitives`) shared by the registry's
  default ACL and `MeshACL`; before, the default ACL looked at two segments only,
  so three-segment scopes such as `mesh-relay:<svc>:connect` matched only through
  `*:*`, and the shared matcher ignored every segment past the third. A grant
  with `expiresAt` is announced like a revocation (`onAccessChange`, kind
  `expired`) by one timer per registry, for the nearest expiry. `grant-log` replicates signed grant records (Ed25519,
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
  (off by default). **Signed shards and anonymous keys** (opt-in; give the agent
  an `identity`, optionally a `lookupNonce`):
  - every stored shard is signed (Ed25519) over the agent, the key it lives under,
    its index, the write's sequence number, its content and the nonce; every
    shard read through `hideSigned()` / `reconstituteSigned()` or the encrypted
    methods is verified, and one that does not verify (changed, moved to another
    key, signed by someone else, or an older write mixed into a newer one) is
    refused and counted (`stats.shardBadSignature`, `shardStale`). An **unsigned**
    shard (an older writer) is refused too unless `allowUnsigned: true`
    (`stats.shardUnsigned`). An agent with an identity cannot use the
    synchronous `hide()` / `reconstitute()` / `isViable()` (they throw
    `async-required`) so it never writes or reads unsigned by accident; agents
    without an identity are unchanged. Signatures do not stop someone
    overwriting a key: the DHT still accepts a `store` from anyone, so a
    forged overwrite makes the shard unusable (refused, counted) rather than
    accepted.
  - with a `lookupNonce` (at least 16 base64url characters; derive it from the
    group secret with `deriveStealthLookupNonce(secret, agentId, epoch)` so every
    member can find the shards, or keep a random one wherever the agent's
    custodian keeps its keys) the DHT keys are `hex(SHA-256(agentId, nonce,
    index))` and the stored records hold no agent id, shard id or public key. A DHT
    observer who does not know the nonce cannot link a key to the agent or the
    shards of one agent to each other **by key**. It can still see that records
    exist, their sizes and timing, and fields shared by one write (`seq`,
    `checksum` style values), so a determined observer can group them; the data
    itself is plaintext unless `hideEncrypted()` is used. Whoever holds the nonce
    can find (not read) the shards; rotating it (`epoch`) moves the shards.
  - not protected: the content of `hideSigned()` shards (plaintext slices),
    that something is stored, availability against overwrites, and a group-key
    holder reading or forging encrypted state (the sender is a label, not a
    signature, on that path). Multi-loss parity is not done; threshold key
    sharing is design only (`design/stealth-threshold.md`, issue #230 and its
    follow-up).
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
| isolate, `isolated-vm` (`createIsolatedVmRuntime()`, optional dependency) | modules from the host's catalog only | language, **in the host's own process** | no `require`, `process`, filesystem, network, timers or `WebAssembly`; one frozen context (`name`, `env`, `input`, `log`); only JSON strings and one log callback cross; heap and per-call time limits that dispose the isolate and report `oom` or `timeout`. A V8 or `isolated-vm` memory-safety bug is a bug in the host process (it can reach everything the host can); the heap limit is a guideline (2 to 3 times is possible); there is no cumulative CPU budget | unit, including escape tests (constructor chains, prototype walks, thenables, re-entrancy, memory and CPU exhaustion); run with the addon's prebuilt binary (no install script, no compiler) on macOS arm64 (Node 26.10), Linux arm64 and x64 on glibc (Debian, Node 26.0.0 and 26.13) and Linux arm64 on musl (Alpine, Node 26.13), and in CI on ubuntu-latest, where a missing addon fails the job instead of skipping. Do **not** start the host with `--no-node-snapshot`: it is not needed on Node 26, and with it the process sometimes aborts at exit (an `isolated-vm` assertion; about 1 run in 10 of the test file on Linux arm64, none in 165 runs without the flag). Never against a real V8 exploit |
| isolate `workerd` | specified only | language | not built | never |
| browser in-page / CDP / extension | yes (a page) | tab / browser context / extension world | in-page: no sandbox attribute, a same-origin pod shares the parent's storage; CDP: the browser's network position; extension: the extension's permissions | unit and fakes; one e2e with headless Chrome for CDP |

Across lanes: a pod belongs to the requester that spawned it (`send`, `exec`,
`snapshot`, `restore` and `drain` need ownership or an explicit grant on the pod,
`<resource>/<name>:<verb>`, not only the verb on the host resource; ownership is
in memory); `env` values and
`run.input` are shown only to the requester that spawned the pod; `describe()`
is ungated; placement refuses an untrusted requester on a weak boundary. Not
defended: hypervisor, kernel and V8 vulnerabilities, side channels, the host
operator (who can read guest memory, snapshots and keys), restoring one snapshot
twice (two pods, one identity), resource exhaustion beyond configured limits.

## What is verified how

| Layer | unit | duplex / in-memory | real peer | real browser (CI) | never |
| --- | --- | --- | --- | --- | --- |
| Identity | yes | | | generate, sign, verify | handshake token with a real signaling server |
| Pod messages | yes | | | BroadcastChannel (and cross-origin invisibility), WebSocket relay (test double) | real `browsermesh-servers` relay |
| Signalling registration (protocol 2), server stamps, ICE fetch | yes (a double that verifies the proof) | | yes, against the real signalling server as a child process, both modes (opt-in; skipped where its checkout is absent) | | browser; TURN credentials actually used |
| BroadcastChannel / WebSocket links | yes | | | yes | |
| WebRTC channel | yes | | yes | yes (loopback, no STUN) | NAT traversal, TURN |
| WebRTC identity binding | yes | yes (fake peer connections) | yes (`createMeshNode`, node-datachannel) | yes: a real `RTCPeerConnection` in Chromium and Firefox (WebKit does not open a data channel in the local run), including a signalling server that swaps the descriptions | |
| wsh link | yes | in-process pipe relay, real wsh sessions | | | browser, real relay |
| WebTransport, wisp, relay client | mocks | | | | real servers |
| Routed sealing (key statements, seal and open) | yes (each rule broken once: plaintext at the hop, header, statement signature, expiry, downgrade, replay) | fake buses | yes: three real WebRTC peers, key fetched through the hop (node-datachannel) | yes: X25519, HKDF, AES-GCM and Ed25519 in Chromium, Firefox and WebKit, across two pages | an older release as the hop (a literal copy of its forwarding step is tested, not the release); revocation reaching a sender in a real network; timing and size leakage |
| Relay | yes | in-memory services | yes | | browser |
| Shared servers | yes (real loopback upstreams) | | | | browser |
| mesh-rpc / `browserMeshFetch` | yes | JSON-boundary network | | echo and 404 over a data channel | with a registry and identity in a browser |
| Message channel, protocol seam | yes | in-memory duplex | | yes (two browsers, real WebRTC) | |
| Sync | yes | | | CRDT convergence over a data channel | file transfer over a real link |
| Discovery, DHT, StealthAgent | yes | | | | any network |
| Hosted pods | yes (fakes) | | | | real microVM, Firecracker host, `workerd`; `isolated-vm` against a real V8 exploit |

Not verified anywhere here: anything needing STUN/TURN or a non-loopback
network, the real `browsermesh-servers` relay (the signalling server is run for
real only by the opt-in signalling-server suites, not in CI), service workers,
GPU and IndexedDB in a real browser.
