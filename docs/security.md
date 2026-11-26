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
[MCP across the mesh](#mcp-across-the-mesh) · [HTTP ingress](#http-ingress) · [egress](#egress) · [sync](#sync) · [discovery and StealthAgent](#discovery-and-stealthagent) ·
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
| `browsermesh-apps` | implemented, with partial modules | registry, grant log, audit, mesh-rpc, mesh-fetch, message channel, protocol seam, relay host and backend, sync, cloud storage, key distribution, KV, escrow, pod-host service, placement, supervisor: implemented (mostly in process; a few over real peers). Partial: `mesh-bootstrap` (one real-peer test file), torrent (single-process fallback; real WebTorrent only under `test/real-torrent`), `peer-ipfs` (a local SHA-256 store, not IPFS), `peer-terminal` (no default shell), serverless executors (not an adversarial sandbox), GPU (real WebGPU only in a dedicated test), `mesh-dht` (no authentication unless the opt-in signed stores and store policy are turned on), `compat.mjs`. |
| `browsermesh-objects` | implemented | wsh's remote-object layer (`@johnhenry/wsh/objects`, a peer dependency) over a protocol channel, authorised per root and per action for the channel's verified peer (values, events, handles, callbacks: unit over an in-memory bus, real WebRTC peers, and real browsers). Two authorisations apply to every operation: wsh's allow-lists, then the registry grant. Not a sandbox: a `call` runs the host application's function. |
| `browsermesh-sync` | implemented, with partial modules | CRDT, delta sync, memory sync, file chunks, CIDv1, IndexedDB storage (unit, `fake-indexeddb`); CRDT convergence also over a real data channel in a browser. `collab` and `collab-bridge`: partial (marked experimental; stub document when Yjs is absent). |
| `browsermesh-discovery` | partial | DHT has no iterative lookup (below); discovery strategies unsigned; naming, swarm, service-worker routing implemented (unit, unauthenticated); StealthAgent plain path documented as plaintext, encrypted/keyring path implemented; opt-in threshold sharing of the group secret implemented (dealer model, unit only; `docs/design/stealth-threshold.md`). |
| `browsermesh-netway` | implemented | loopback, virtual network, policy, queue, sockets (byte-level backpressure), listener, router, service and fs backends, chaos wrapper (unit). `gateway-backend`: implemented, tested against a mock wsh client and against a real wsh server host and a real in-memory host (`test/gateway-real-wsh.test.mjs`); HOST_UNREACHABLE, TIMEOUT and CLOSED are mock-tested only. `backend.mjs`: abstract base. |
| `browsermesh-kernel` | implemented | in-process microkernel with capability checks and resource tables; unit tests per module. No cryptography; isolation is by capability and ownership checks, not process boundaries. |
| `browsermesh-priority-mux` | implemented | sender-side priority scheduler and framer (fake adapter tests). No authentication or encryption. The reassembler has no limit on pending messages. |
| `browsermesh-realm` | implemented (pure logic only; private, not yet used by anything) | realm descriptors, root rotation, roles, credentials and the issuer ledger as pure functions over strict canonical JSON and Ed25519, with language-neutral test vectors (unit; hostile-input and threat-model suites). No I/O, no network, no registry integration and no realm exchange yet, so nothing enforces a realm anywhere; design in [docs/design/realms.md](design/realms.md). |
| `browsermesh-mcp` | implemented | a page's WebMCP tools (or an explicit list) as the protocol `mcp` on the protocol seam, and a client for it; per-tool grants, approval kept with the serving page, bounds. In-memory bus (unit), real peers over WebRTC (Node) and two real browsers; threat model [below](#mcp-across-the-mesh). Depends on wsh's WebMCP bridge (peer dependency) through one adapter file. |
| `browsermesh-ingress` | implemented | real HTTP in, a mesh pod answers: a bounded request forwarder (`createMeshIngress`, a Node listener on its own entry, a CLI) and the provider side (`serveHttpOnMesh`) over the protocol `http` on the protocol seam. Pinned to the pod a mapping names, default deny on the provider, safe defaults on every dimension (unit over an in-memory bus, hostile provider and hostile client suites on real sockets, real WebRTC peers including the CLI as a child process, and a page as the provider in three real browsers). The hooks are told what the link proved (`peer.verified`: `bound`, `wsh`, `key`, or `none`), and `requireLinkKey` binds a request's signer to the link's key. Plain HTTP only, no WebSocket upgrade, direct links only; see [HTTP ingress](#http-ingress). |
| `browsermesh-egress` | implemented (TCP, UDP, the fetch form and name lookup; a CLI) | a pod lends its network access to peers that hold a grant: TCP connections, UDP flows, fetches (the provider is the HTTP client and sees them) and A lookups to destinations the operator allows (`createMeshEgress`; `connectEgress` and a netway backend for the consumer, browser-safe; `nodeDialer` on its own entry, on wsh's address guard; the `browsermesh-egress` command) over the protocol `egress` on the protocol seam. Off unless started, default deny, a grant per destination, every address checked after resolution and the checked address dialled, per-consumer and global budgets, audit and meter without contents, revocation ending live connections. Unit over an in-memory bus, a hostile-consumer and a hostile-provider suite, the real address guard with local sockets, two real WebRTC peers moving several MiB each way, and a page as the consumer in Chromium, Firefox and WebKit against a Node provider; see [Egress](#egress). |
| `browsermesh-embed` | partial | widget wrapper tested against a DOM stub only. |
| `browsermesh-meshctl` | partial | loopback mode exercised through all eight verbs; `--wsh-relay` (a sealed, key-authenticated wsh link through a pipe relay, no signalling server or WebRTC) exercised end to end against the in-process pipe relay and a real pod-host service, not a deployed relay; the WebRTC path is wired, not exercised end to end; `--relay` (the unsealed relay dialect) is not used for pod-host traffic, on purpose. |
| `spikes/*` | spikes | `vm-pod-host` (Firecracker driver: never booted a VM), `isolate-pod-host`, `browser-pod-host`; see [hosted pods](#hosted-pods-per-lane). |

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
| `browsermesh-apps` | yes | `.` `./compat` `./mesh-rpc` `./mesh-channel` `./protocol-channel` `./protocol-stream` `./protocol-roots` `./channel-advertisement` `./mesh-fetch` `./mesh-service` `./lean-node` `./peer-registry` | yes | yes | yes |
| `browsermesh-core` | yes | `.` `./compat` | yes | yes | no |
| `browsermesh-discovery` | yes | `.` | yes | no | no |
| `browsermesh-egress` | yes | `.` `./browser` `./node` | yes | yes | yes |
| `browsermesh-embed` | yes | `.` | yes | no | no |
| `browsermesh-ingress` | yes | `.` `./node` | yes | yes | yes |
| `browsermesh-kernel` | yes | `.` | yes | no | no |
| `browsermesh-mcp` | yes | `.` | yes | yes | yes |
| `browsermesh-meshctl` | yes | `.` | yes | no | no |
| `browsermesh-netway` | yes | `.` | yes | no | no |
| `browsermesh-objects` | yes | `.` | yes | yes | yes |
| `browsermesh-pod` | yes | `.` `./node-runtimes` | yes | yes | yes |
| `browsermesh-primitives` | yes | `.` | yes | no | yes |
| `browsermesh-priority-mux` | yes | `.` | yes | no | no |
| `browsermesh-realm` | private | `.` | yes | no | no |
| `browsermesh-sync` | yes | `.` | yes | no | yes |
| `browsermesh-transport` | yes | `.` `./wsh` `./wsh-in-process` | yes | yes | yes |
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

### One key in both worlds

A pod's key and an OpenSSH or wsh key are the same kind of key: an Ed25519 key
whose hash names it (`base64url(SHA-256(raw public key))` is the pod id, the
same hash in hex is wsh's fingerprint, and `ssh-ed25519 AAAA...` is the key
itself). Primitives has the one conversion between the three names
(`podIdToFingerprint`, `fingerprintToPodId`, `podIdFromOpenSSHPublicKey`) and,
on a `PodIdentity`, two explicit exports: `toOpenSSHPublicKey()` and
`toAuthorizedKeysLine({ capabilities, expires, comment })`. **Nothing calls
them for you.** An identity is never written to an `authorized_keys` file, an
SSH agent or a machine by this repository, and a key that was never exported
this way is not trusted by any machine.

What listing a pod's key in a machine's `authorized_keys` means, plainly:

- **A pod's key usually lives in browser storage.** It sits in IndexedDB, in the
  clear unless the vault storage is used, or as a non-extractable `CryptoKey` in
  a browser profile. Anything that can use that profile can sign as the pod:
  a stolen or shared profile, a malicious extension, a script on the same origin
  (and any XSS there), an unlocked laptop. Once the key is also listed on a
  machine, **the same access reaches that machine**, and it does not stop at the
  edge of the page.
- **Machine rights are never granted from mesh trust.** Being trusted, granted a
  capability or reachable on the mesh gives no access to a machine, and no code
  here derives one from the other. A machine's own `authorized_keys` decides
  who reaches it, in its own notation and by its owner. (The one registry grant
  that names outbound network access is the egress package's own `egress:*`
  scope family, written by the operator of a pod that lends its network, never
  derived from trust, and not a wsh `gateway:` capability: see
  [Egress](#egress) and `capability-notation.md`.)
- **A non-extractable key can still be used by whatever runs in the page.** Not
  being able to copy the key out does not stop the page from asking for
  signatures.
- **No private key crosses.** Only the public key line is written. There is no
  OpenSSH private key parser here (nor in wsh), so `PodIdentity.fromOpenSSH...`
  does not exist: a private key moves as PKCS#8 (`fromPkcs8`,
  `exportPrivateKey('pkcs8')`), and converting an OpenSSH private key to PKCS#8
  is left to the tools that already read those files.
- **The generated line is narrow on purpose.** `capabilities` is required (an
  empty list is a key that may do nothing), characters that could end an option
  or the line are refused, and `expires` is written in the form wsh checks at
  login and on every later request. wsh fails closed on a capability it does
  not know.

When it is reasonable: a machine you control, a short `expires`, a list of
capabilities that names only what that pod needs (for example `mcp:search` or
`objects:app:get`, and not `exec`), a key that lives in a hardware-backed signer
or a non-extractable key on a profile only you use, and a record that you listed
it so you can remove it. When it is not: a long-lived or unrestricted line for a
key kept in a browser you do not control, a shared or synced profile, a pod
that runs code from others, or any case where you would not want a script on
that page to hold a shell on the machine. If in doubt, make a separate key for
the machine and give the pod nothing.

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

### Link admission

Opt in (`createMeshNode({ admission })`, or `createLinkAdmission()` and `WshPeerLinks({ admission })` by hand); off by
default, and without it nothing here applies. A link whose peer is not yet known is held in a restricted state until a
handler you supply promotes or closes it. Design: [`design/link-admission.md`](design/link-admission.md).

Authenticated: over wsh the restricted peer's key is the one wsh verified (`proven: true`); over WebRTC `proven` is true only
when the identity binding verified the peer, and `decide` is told which. The seam does not interpret a frame: whether a
frame proves anything is the handler's.

Bounded: at most `maxRestricted` restricted links (default 8; the next is refused `restricted-full`), each closed after
`deadlineMs` (default 10 s) unless promoted or closed, each inbound frame over `maxFrameBytes` (default 16 KiB) dropped before
the handler, each outbound frame over it refused. A restricted wsh peer holds `endpoint:mesh-admission`, not `endpoint:mesh`,
so wsh's own capability check keeps it off the mesh endpoint; its link is not a peer, so no mesh service, `peer-up` or
`onIncomingData` sees it. An older transport that cannot hold a restricted peer is not trusted to: the admission authorizer
returns the restricted verdict only to a transport that passed `{ restricted: true }`, and refuses otherwise.

Not protected: memory per restricted wsh link is bounded by the hub's `maxFrameBytes` (1 MiB), since the seam's smaller cap
drops frames after they are decoded; a burst of strangers larger than the waiting halves can leave an honest dialler unpaired
for one relay round trip (the cap counts strangers only once restricted); over WebRTC a local `connectToPeer()` to a peer
whose inbound link is held adopts that connection as a caller session; links this node dials are never restricted; a
registry access re-check does not cover a restricted link; the seam ships no realm messages, credentials or grants (the
handler is the caller's, and its correctness is not covered here).

Verified: unit tests of the seam (cap, deadline, one-shot promote and close, frame cap, counters); wsh over the in-process
pipe relay with real sealed sessions, through `createMeshNode` (a stranger held, handler frames only, nothing reaching
`onIncomingData`, promote adopting it) and through `WshPeerLinks` directly; the WebRTC gate over mock transports; the
fail-closed negotiation (an authorizer called with one argument refuses, and a stub that grants on any truthy verdict
refuses). Never: a real relay, a real WebRTC connection through the gate, a published older transport release (a stub with
its grant rule is tested, not the release).

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
- **Over a mesh channel.** The same services can be served to a mesh peer over a protocol channel
  (`services.serveOnMesh(service)`, `connectWshServicesOverMesh`; design
  [`design/wsh-over-mesh.md`](design/wsh-over-mesh.md)), off unless called. The channel needs
  `protocol:wsh:open` (default deny, asked on every message); the services grants above are asked
  on top; the key that logs in must be the channel's verified peer's own; the session is sealed and
  the client pins the pod id. A hop that carries the channel can see that a session exists, its
  timing and sizes and the plain handshake (host key, user name, client key), and can drop, delay or
  end it; it cannot read, alter, replay or take over anything after sealing. Verified: the real wsh
  client over the in-memory bus with a hostile hop (reads, alters either direction, drops) and over
  real WebRTC (`browsermesh-apps` `test/wsh-services-mesh.test.mjs`, `test/real-peer/`).

### A relaying pod (wsh `--via` over the mesh)

Package: `browsermesh-transport` (`WshRelay`, `connectWshServicesViaRelay`, `wsh-relay.mjs`). Design:
[`design/wsh-over-mesh.md`](design/wsh-over-mesh.md) ("The relaying pod"); the owner decided to build it with a per-target
grant. A pod carries a requester's sealed wsh session to a target it can reach, without reading it. **Off:** nothing in the
repository constructs it; `start()` needs an `indicator` or `unattended: true`.

- **Who may ask.** The control channel needs `protocol:wsh-relay:open` (default deny, asked on every message) and each session
  needs **`wsh-relay:<target>:open` for that exact target** (a pod id, or a name the operator mapped to a pipe relay URL and
  rendezvous id). The target is never an address the requester supplies, so the relay is not an open proxy and cannot be aimed
  at an address of the requester's choosing. A wildcard target in the configuration is refused at creation, and a requester's
  `wsh-relay:*:open` grant is refused at request time, unless `wideTargets: true`. Revoking the grant ends the session at once.
- **Bounds.** At most `maxSessions` at once (default 2), one per requesting pod, a byte budget, a time budget and an idle timeout
  per session; each refusal and end is named and audited (`relay-open`, `relay-refused`, `relay-close`: pod ids, target, bytes,
  duration; never content). A relayed session is not relayed onward (hop marker plus the grant model).
- **What the relay sees and can do.** Who asks for which target, that a session exists, its timing and sizes, and the plain
  handshake (host key, user name, client key). It can drop, delay, end or refuse. It cannot read, alter, replay or take over a
  sealed session, and it cannot answer as the target: the client pins the target's host key (a pod id for a pod; the key the client
  names for a machine), and the target requires sealing and decides on the KEY (`wsh-services:open`) carried by a relay it lists in
  `acceptVia`. The relay never terminates wsh and cannot tell a sealed session from a plain one; the target refuses a plain one.
- **Not protected.** A relay that is granted a target can make that session fail or stall, and learns who talks to whom and when;
  a granted requester can make the relay open sessions to the targets it is granted, up to the bounds.
- **Verified.** In memory with real registries and the real wsh client (allowed and refused requesters, a target not granted, wildcard,
  count, byte, time and idle bounds, no chains, revocation mid-session, a relay that reads, alters either way or drops, a relay that
  answers as the target, a machine host behind a mapped name) and over three real WebRTC peers
  (`browsermesh-apps` `test/wsh-relay.test.mjs`, `test/real-peer/wsh-relay.test.mjs`). Each rule was broken once. Not in a browser.

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
  handlers. `grantCapabilities` refuses a malformed `objects:` or `mcp:` scope
  (an empty root or tool would otherwise read as `*`); how these scopes relate
  to wsh's key capabilities, and where the two differ, is in
  [`capability-notation.md`](capability-notation.md).
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
- **Remote objects.** The remote-object layer lives in wsh
  (`@johnhenry/wsh/objects`); `@johnhenry/browsermesh-objects` runs it over the
  seam (`exposeObjectsOnMesh`, `openObjectsOnMesh`; `examples/19`). Every
  operation is judged by its own action through `createRootAuthorizer`
  (`objects:<root>:<action>`: `get` for get, describe and snapshot; `call` for
  call, construct and the callbacks passed to a call; `set`; `on` for a
  subscription), for the channel's verified peer, after wsh's allow-lists have
  said yes; an unknown operation is refused. A request is judged when it
  arrives; an open subscription needs `on` and an open callback needs `call` at
  every delivery, and a revoked or expired grant ends the session (at once when
  the host passes `watch`). Events and callbacks leave through the channel's
  credit, the layer's bounded queue drops and counts what a slow reader cannot
  take, and a peer that keeps asking without reading is cut off. The layer also
  asks the registry (`permit`, from wsh 0.51) before it reads on the way to
  something and before it describes a root: a root the peer holds no action on is
  not described (the description of a root lists the host's allow-list entries
  and type map, narrowed to the actions the peer holds). An event subscription
  made through a handle is judged for the root of the handle's path and needs
  `on` at every delivery, as a path subscription does.
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
  `expired`) by one timer per registry, for the nearest expiry. Realm grants
  (`docs/design/realms.md`) are a separate source, unioned with these in
  `checkAccess` and never persisted: a host honours no realm unless its
  `realmPolicy` lists the realm id and, per role, the scope patterns it may
  grant; `egress:`, `ingress:`, `pod-host` and `wsh-` scopes only when named
  there, and a wildcard or short scope is refused. `grant-log` replicates signed grant records (Ed25519,
  self-verifying pod ids, authorization replayed deterministically; `at` is
  caller-supplied, revoking an admin is not retroactive). The audit chain
  (hash-linked, signed per entry) is off unless `enableAudit`. Unit only.

## MCP across the mesh

Package: `browsermesh-mcp` (`serveMcpOnMesh`, `openMcpOnMesh`). Design:
[`design/mcp-over-mesh.md`](design/mcp-over-mesh.md). A page's WebMCP tools, or an
explicit list, are served as the protocol `mcp` on the protocol seam; another pod
lists and calls them. Plain MCP JSON-RPC rides the channel; the tool bridge is
wsh's (`@johnhenry/wsh/page`, a peer dependency), behind one adapter file.

Threat model, by what an attacker is and wants:

- **A peer that has no grant** (or a link that was never authorised): wants to
  see or run the page's tools. Opening needs `protocol:mcp:open` (default deny; an
  unserved name and a denied one look the same). A peer with only the open scope
  sees an empty list. A tool is listed to a peer only with `mcp:<tool>:list` and
  callable only with `mcp:<tool>:call`; both are asked of the node's registry on
  every request, so a revocation or an expiry applies to the very next call, and
  revoking the open scope closes the channel at once. A tool the peer may not call
  and a tool that does not exist get the same answer, so probing learns nothing;
  probes are counted against the per-minute bound. Tool names that cannot sit in a
  scope (`:` or `*`, a leading `_`, `.` or `-`) are never granted and never served.
- **A peer that has a grant and wants more than the person at the page agreed
  to.** A grant lets a peer *ask*; it is not an approval. A tool that is not marked
  read-only is asked about before it runs, by the **serving page's** prompt
  (`approve`: never, consequential (default), always), showing the caller's verified
  pod id and the input as text. The prompt, its timeout and its outcome are on the
  serving side only; the caller cannot answer, see or influence it, and a cancel
  closes the question. With no prompt and no document, what needs approval is
  denied. `approve: 'never'` is the page's explicit choice.
- **A caller that lies about who it is.** The caller is the channel's verified
  peer (the key the session is bound to), never a message field; params that claim
  another identity are ignored. How strong that key is depends on the link (see
  [peer links](#peer-links-by-transport)).
- **A tool (or a third party whose text it returns) that attacks the caller.** A
  result is data: delivered as text, labelled untrusted in the result (`_meta`) and
  by the client (`untrusted: true`), and no tool can unset the label. Nothing in
  this layer parses, renders or evaluates it; what the caller's own software does
  with the text (a model reading it as instructions) is out of this layer's reach,
  and is why the label exists.
- **A caller that wants to exhaust the page.** Bounded by name: tools listed
  (`maxTools` 64), schema bytes (16 KiB), input bytes (64 KiB), result bytes
  (256 KiB, refused not truncated), calls in flight (4) and per minute (30) per
  session, a call timeout (120 s) after which the tool's `signal` aborts; below
  them the channel's own message, window and in-flight bounds. Cancelling a call, or
  closing the channel, aborts the tool's `signal`.
- **A caller that wants the page to act as a client.** Not possible: the server
  never sends a request, and the client registers no request handler, so sampling,
  roots and elicitation are answered -32601. No resources and no prompts are
  offered; `initialize` advertises `tools` only.
- **Not protected.** A tool does what its `execute` does with the serving user's
  session: the allow-list, the grants and the prompt narrow who can start it and when,
  not what it does. A grant is per tool, not per argument. The label does not stop a
  caller from believing a hostile result. The channel is as confidential as its link
  (DTLS on WebRTC; nothing extra here). A grant change is not pushed to a connected
  caller; its next `tools/list` or call reflects it.
- **Verified.** Unit (in-memory bus; each rule above has a test that fails when the
  rule is broken); two real Node peers over real WebRTC
  (`packages/browsermesh-mcp/test/real-peer`); two real browser contexts over a real
  data channel in Chromium, Firefox and WebKit (`tests/browser/mcp-over-mesh.spec.mjs`:
  default deny and per-tool grants, revocation, the page's prompt, a hostile result as
  inert text, cancel reaching the tool, list-changed). The default DOM prompt of wsh's
  bridge is not exercised there (the harness answers with its own `prompt`).

## HTTP ingress

Package: `browsermesh-ingress` (`createMeshIngress`, `serveHttpOnMesh`, `listenNode`, the `browsermesh-ingress`
CLI). Design: [`design/http-ingress.md`](design/http-ingress.md). A real HTTP request reaches a listener; a mapping the
operator wrote names ONE pod; that pod answers over the protocol `http` (version 1) on the protocol seam, bodies on the
protocol streams.

**The operator serves content they do not control.** The provider can answer anything; the HTTP client is anyone; the
ingress is a translating and limiting hop. One origin per provider is the operator's responsibility (two providers behind
one hostname share cookies, storage and script reach in a browser; the CLI refuses two different pods under one hostname).
This is not a CDN, not a file server and not an egress proxy (`ServerSharing` goes the other way and is separate).

Threat model, by what an attacker is and wants:

- **A pod that is not the mapped one, answering.** The answer is accepted only from the pod the mapping names: the
  channel is opened to that pod and `channel.peer` (the session key, never a message field) must equal it, or the channel
  is closed and the client gets 502 `provider-pin-mismatch`. A `rid` is honoured only on the channel it was issued on.
  **Routed (multi-hop) delivery is not part of v1**: the protocol channel rides direct links, so a pod with no direct link
  is refused (502 `provider-unreachable`). Optional signed responses (`sign` on the provider, `verifyResponse` on the
  ingress; the signature covers the status, the headers as sent, the SHA-256 of the body, the request and a fresh nonce)
  make the pin independent of the transport.
- **A provider that wants more than it was given.** It is never told who the client is (unless `forwardClientAddress`),
  never gets cookies or credentials (an allow-list of request headers; `Host`, `Forwarded`, `X-Forwarded-*`, `Upgrade`,
  `Proxy-*`, framing headers are never forwarded, whatever the operator allows), and a peer never supplies a URL the
  ingress fetches: the target is built from parsed parts and the ingress fetches nothing. A provider serves only ingress
  pods it granted: `protocol:http:open` in its registry (default deny) and `allowFrom` (required); revoking the grant
  closes the channel at once.
- **An ingress whose pod id is new each session.** `allowFrom` may be a function `(podId, context, peer)` (asked on open and for
  every request; only `true` serves; a throw refuses; omitting `allowFrom` is still an error). With a function, **the
  provider's own check carries the weight**: the pod id and the registry grant no longer name the ingress, so the provider
  verifies another proof, for example a signed request. `verifyRequest(request, { peer, sig, bytes }, peer)` on the provider runs
  before the handler and refuses anything but `true`; the ingress's `signRequest` makes the signature, which covers the
  request, a fresh nonce, the headers as sent and the body digest. The package picks no cryptography.
- **What is verified about the link a request came over.** The channel names the pod id a session is addressed by; whether
  that id was proven is a property of the transport. The extra `peer` argument says: `verified: 'bound'` (a direct WebRTC
  connection whose peer proved the key behind its pod id over the connection's DTLS fingerprints), `'wsh'` (a wsh peer link:
  key login, host key pinned to the pod id, sealed), `'key'` (both at once) or `'none'` (nothing was proven: an unbound
  WebRTC connection, a relayed or otherwise vouched-for link, any other transport, or no node given to the package); the key
  fields are present only when something was proven, and a source can only narrow. A request signature alone shows that the
  request was intact and that the holder of the signing key made it; `requireLinkKey` makes the signer's key the link's key,
  and refuses a link that proved nothing, with a named reason (`link-unverified`, `signer-unverified`, `signer-key-invalid`,
  `link-key-mismatch`) in the provider's log and `stats().refusals`. Off unless used. On a link whose peer
  identity is only asserted by a third party (a relay that vouches for who is on the other end), the signed-response and
  signed-request hooks should be mandatory in the application, because the pod id alone is only as good as that third
  party; the protocol channel itself needs only a byte duplex with a peer identity.
- **A provider that is not the right one for a request.** `declineRequest()` is a provider's way to say "not me": the ingress
  reports the named 502 `provider-declined` and never sends it as the provider's response. `retry` (off by default) asks
  `resolve` again, with the pods already tried, after a failure in which the provider did no work (unreachable, wrong pod,
  declined): at most 1 to 5 more times, one deadline, every attempt authorised and audited, never after a provider started
  answering, and `POST` and `PATCH` only on request. There is no multi-hop delivery; `retry` does not route.
- **A hostile provider that wants to hurt the client or the operator.** Bounded: response bytes (8 MiB; a declared length
  over it is refused before anything is sent, a body that outgrows it is cut), the whole request (30 s), idle time between
  chunks (15 s), header count and bytes. Outbound headers are an allow-list: `Set-Cookie`, `Content-Encoding`,
  `Strict-Transport-Security`, `Refresh`, CORS and unknown headers are dropped; `Content-Security-Policy: default-src
  'none'; frame-ancestors 'none'; sandbox` (a response is never framed by default), `X-Content-Type-Options: nosniff`,
  `Cache-Control: no-store` and `Vary` are the ingress's; a mapping can opt out of the policy only explicitly, and can add
  headers its operator wrote (`response.addHeaders`: at most 16, no line breaks, no hop-by-hop or framing header, and
  never a forced header unless that header's own opt-out is set). A redirect is never followed, and a `Location` that is not a path on the same
  origin makes the response 502 `provider-redirect-refused`. A malformed head, a status outside 200-599, a body the head did
  not announce, a stream for a request that was never made, and a body of the wrong length are each a named 502.
- **A hostile HTTP client.** GET and HEAD only until `methods` allows more; CONNECT and TRACE never; a body on GET/HEAD,
  `Transfer-Encoding` with `Content-Length`, a repeated or signed `Content-Length`, an obfuscated `Transfer-Encoding`, an
  absolute-form target, a `Host` with userinfo, a path, spaces or a second `Host`, and `Upgrade` (426, WebSocket is not
  bridged) are refused before the provider is asked; request body 64 KiB (413), slow body (408), a global in-flight cap
  (64), per client (8) and per provider (16) in flight, per client and per provider rates, a connection cap and header
  timeouts on the listener. The client address is the socket's; `trustProxy` takes the entry the trusted proxy appended
  (the last `X-Forwarded-For` entry for one proxy), never one the client wrote.
- **What the audit shows.** `{ peer, host, method, status, reason?, requestBytes, responseBytes, durationMs }`: never a
  query string, a path or a body.
- **Not protected.** The listener speaks plain HTTP: terminate TLS in front (the CLI refuses a non-loopback bind without
  `--public` and `--tls-terminated-in-front`). What a provider returns is content the operator does not control; the
  policy headers make it inert in a browser but do not make it true. The pin is as strong as the link (DTLS and the
  identity binding on WebRTC). The request body is read whole (bounded) before the provider is asked and, on a page
  provider, before the handler runs; response bodies stream. A legacy site service reached through the opt-in `rpc`
  fallback has no default deny of its own.
- **Verified.** Unit (every header rule, limit and refusal; each rule broken once); the web-standard handler over an
  in-memory bus; a real HTTP client against the Node listener; hostile provider and hostile client suites (raw sockets);
  two real Node peers over real WebRTC and the CLI as a child process through a real signalling server
  (`packages/browsermesh-ingress/test/real-peer`); a page as the provider, the ingress in Node, in Chromium, Firefox and
  WebKit (`tests/browser/ingress.spec.mjs`); the link identity (`peer.verified`, `requireLinkKey`) on a real bound WebRTC
  link, a real unbound one and a real wsh link (`test/real-peer/link-identity.test.mjs`, `test/wsh-link-identity.test.mjs`).
  Not verified: a public deployment, TLS in front, a real CDN or proxy in front, WebRTC through NAT, the link identity of a
  relayed transport over a real relay (a double stands in: it must read `none`).

## Egress

Package: `browsermesh-egress` (`createMeshEgress`, `connectEgress`, `nodeDialer` on `./node`). Design:
[`design/egress.md`](design/egress.md). A pod with real sockets lends its network access to peers that hold a grant: a TCP
connection to `host:port`, UDP datagrams to one address, an A lookup and a fetch-shaped HTTP request, over the protocol
`egress` (version 1) on the protocol seam, bodies on the protocol streams; a `browsermesh-egress` command runs a provider
from a grants file.

**What an operator takes on.** Their address is what every destination sees; complaints and blocks go to them. A grant is
trust in a pod key, not a person. In the TCP and UDP forms the provider relays bytes it does not read (no TLS code is in
that path, and the audit and meter carry no contents), but for a plain protocol the operator's machine carries the
plaintext. The consumer's own TLS is what protects what is said to a destination from the provider; the provider's lookup
answers are not an identity. **The fetch form is different: the provider is the HTTP client**, a browser tab cannot run TLS
on a raw stream, so for `https:` the provider does it and its operator's machine reads the URL, the headers, the request body
and the response, and could alter the response. A fetch grant is trust in the provider with that request, which is why it is
its own scope (`egress:http:<host>:<port>:fetch`), why the form is off unless the operator passes an `exchange`, and why the
CLI's dry run says it in words.

The rules, each with the refusal it gives (the codes are exported as `REFUSAL_CODES`, `BUDGET_NAMES` and `END_REASONS`, and
the README's tables are checked against them):

| Rule | What the provider does | Refusal or end |
| --- | --- | --- |
| Off unless started | `createMeshEgress` serves nothing until `start()`, which needs an `indicator` or `unattended: true` | `provider-no-egress` for the consumer |
| Who may open the channel | `protocol:egress:open`, default deny, asked again for every message of the channel; `allowFrom` narrows further | `provider-not-authorized` |
| A grant per destination | the registry is asked for `egress:tcp:<host>:<port>:connect`, `egress:tcp:<host>:*:connect` or a set's `egress:set:<name>:connect`; a request with no grant is answered the same whether or not the destination exists, before any lookup | `no-grant` |
| A lookup is its own grant | `egress:dns:<name>:resolve`; connecting by name does not carry it | `no-grant` |
| An address is not its name (unless the operator says so) | a grant for a name does not cover the address the name resolves to. With `connectByResolvedAddress` (off by default) a `connect` to an address the provider's OWN lookup returned for that consumer, within `addressMemoryMs` and `maxRememberedAddresses`, is decided by the consumer's `dns` and TCP grants for the name it was returned for: it is dialled as it is (no second lookup), through the same address guard, with `deny` asked about the address and the name; an address returned for a name the consumer has no TCP grant for, a port the grant does not name, or another consumer's lookup gives nothing | `no-grant` |
| A header that carries a URL is the provider's word | the fetch form passes `www-authenticate`, `link` and `location` (and the registry and rate-limit headers on its allow-list) and never `Set-Cookie`; the consumer's request to a URL a header names is its own fetch and needs its own grant | `no-grant`, `redirect-refused` |
| A dead peer is noticed | each end pings the other on the channel (every 5 s) and declares it gone after 3 silent intervals; a gone consumer's channel is closed and its connections and budgets freed; an older peer answers method-not-found, which counts as an answer | `consumer-left`; the consumer's `provider-gone` |
| One grant per form | `egress:http:<host>:<port>:fetch` (or `:*:`, or a set's `egress:set:<name>:fetch`) for the fetch form and `egress:udp:<host>:<port>:send` for UDP; a TCP grant is neither, and a fetch grant is not a TCP grant | `no-grant` |
| The fetch form's request | `http:` and `https:` only, no credentials in the URL, a lowercase DNS name or IPv4 address, no pod id; methods are the operator's list (GET and HEAD by default; never CONNECT or TRACE); headers are allow-lists in both directions (no cookie, no `Set-Cookie`, no hop-by-hop or proxy header, `Host` from the parsed URL only); no `Authorization` of the provider's own is ever added | `bad-url`, `method-not-allowed` |
| Redirects are requests | each hop must be a destination the consumer also holds a fetch grant for, is address-checked again, meets the blocked ports and `deny`; `https:` never falls back to `http:`; `Authorization` is dropped when the origin changes; at most 5 | `redirect-refused`, `too-many-redirects`, `destination-refused` |
| TLS is verified against the name on the checked address | the handshake runs over the socket the guard connected (no second lookup), with the name as SNI and the operator's trust roots; a certificate for another name is refused before a request byte is written | `connect-failed` (`certificate`) |
| UDP | a datagram socket connected to the checked address (the kernel drops every other source); one destination per flow; port 53 refused for every grant, wide mode included; datagrams are dropped (never truncated) over the rate, over the flow's budgets, or larger than the bound; **replies are bounded by what the consumer sent** (credit earned per datagram sent, capped), so a destination cannot amplify a small request | `budget-exceeded` (`udp-flows-per-consumer`), `port-blocked`; a flow ends `datagram-budget`, `byte-budget`, `idle` |
| One spelling per address | hosts are lowercase DNS names or four plain decimal numbers; every other spelling of an address, a port in the host, a trailing dot and IPv6 literals are refused before any rule is asked | `bad-destination` |
| Wildcard grants need an acknowledgement | the registry is asked about the literal-`*` forms for each request; a holder of one is refused unless the operator wrote `wide: { acknowledge: 'any-public-address' }`, even if an exact grant also covers the request; sets cannot hold a bare wildcard | `wide-not-acknowledged` |
| Addresses are checked after resolution, and the checked address is dialled | a name is resolved once, every answer is classified by wsh's address guard, and the connection goes to an address that passed, never to the name again; a name whose answers mix a public and a refused address is refused whole | `destination-refused` with `addressClass` |
| Private space belongs to the operator | private, loopback, link-local, unique-local, carrier-NAT, metadata, multicast and reserved space is refused; only the operator's `allowPrivate`, for destinations a grant names, admits private space, and a wildcard grant (wide mode) never does, whatever the operator allows for named destinations. The public addresses of the provider's own interfaces are refused by default | `destination-refused` |
| Blocked ports | 25, 465 and 587 by default, for every grant and in wide mode (where the defaults cannot be removed); the operator replaces the list otherwise | `port-blocked` |
| Budgets | per consumer and global: connections, connection attempts per window (refused attempts count), lookups per window, bytes per connection, bytes per consumer per 24 hours; connect, idle and total time. Every limit is a finite positive whole number | `budget-exceeded` with `budget`; a live connection ends `byte-budget`, `consumer-budget`, `idle` or `time-budget` |
| Backpressure | a consumer that stops reading stops the destination once the consumer's socket window and the stream window (256 KiB each by default) are full (576 KiB had moved in the real-peer run; the tests assert a bound of 1 MiB); a destination that stops reading stops the consumer's writes; both halves close independently | |
| Stream rules | a sender that is out of sequence, past its credit or past its size is cut off by the stream layer, and past a budget of such breaks the consumer's connections end and its channel closes | `stream-abuse` |
| Revocation | the registry's access changes, a 30 s interval and `recheck()` ask again, for the scope each connection was opened under; one whose grant is gone ends at once, in both directions | `revoked` |
| No chaining | a request must carry `hops: 0`; a provider cannot be built on a `dial` or `resolve` that is an egress consumer, and a socket that is not a network socket is a failed connect; a mesh pod id is not a destination, on either end | `chaining-refused` |
| Audit and meter | `onAudit` records who, the destination host and port, the address class, bytes each way, duration and outcome (a fetch: the method, the status, each hop, and the length of the path and query, never the path or query unless the operator chose `auditUrls`); `onMeter` records the same counts without a destination; neither carries contents or headers, and a sink that throws never breaks a connection | |

**Not protected.** What a granted destination does with the bytes, including a granted host that forwards them elsewhere.
The provider's operator sees destinations, sizes and timing, and plaintext for a protocol that has no TLS. A consumer that
is itself compromised, within its grants and budgets. Naming inside a TLS stream: a grant is for an address, and the
provider does not look inside. Traffic analysis. Availability: stopping the provider drops every connection and there is no
resume. Confidentiality across a relayed link: the protocol is for direct links, as ingress. The block on the mail ports is
a default, not a guarantee about other ports. IPv6 destinations are not offered. **What a consumer cannot check about a
provider it picked:** a fetch `Response` (status, headers, body, `response.url`) and a UDP datagram are the provider's word;
nothing authenticates them unless the protocol inside does (check the digest of what you downloaded; use DTLS or QUIC). The
legal and operational exposure of an operator is theirs.

**Verified.** Unit (every rule and every refusal code; each rule broken once); a hostile-consumer suite over the raw protocol
channel (no grant, other scopes, a resolver that changes its answer, floods of opens, malformed requests, broken stream
rules, chaining); wsh's real address guard with real local sockets; two real Node peers over real WebRTC with a local
origin (several MiB each way with every byte checked, a slow reader, a revocation mid-transfer, a refusal of private space;
`packages/browsermesh-egress/test/real-peer`); the fetch form against local HTTP and HTTPS origins (a redirect chain ending at
a metadata or private address, a name that answers differently the second time, a certificate for another name, an oversized,
slow or lying response, a consumer that stops reading); UDP against a local datagram origin (a flood, replies over the credit,
a consumer that does not read, a provider that lies to the consumer); the wire against the published 0.1.1's messages in both
directions; the `browsermesh-egress` command as a child process behind a local signalling server, reached over real WebRTC for
TCP, a fetch and UDP, with its audit lines checked for contents; and a page as the consumer in a real browser (`tests/browser/egress.spec.mjs`: TCP, a fetch and UDP granted, a
refusal by name, the guard refusing loopback, metadata and private space even with a grant, a revocation, a cancelled body).
Not verified: a public destination, throughput
or behaviour through NAT or a TURN relay, a registry grant arriving through an ACL template rather than
`grantCapabilities` (the literal-`*` forms are asked of the registry's own matcher, which the grants tested here go
through).

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
  (`k` = 20 per bucket; TTL optional, default none) **unless the node is given a
  `storePolicy`** (opt-in; below). Tests are single-process.
  - **Owned stores** (opt-in, `storePolicy`; `design/discovery-records.md`, item 3): a
    `DHT_STORE` may carry a proof (`auth`: writer key, `seq`, absolute expiry, Ed25519
    signature over key, value digest, `seq`, expiry). A node with a policy verifies it
    and enforces: a pod-id-shaped key can be stored only by that pod; the first valid
    signer owns an agent-anonymous or `shard3` key (`open` mode) or any key outside
    `openPrefixes` (`owned` mode, which also refuses unsigned stores) until the entry's
    expiry; an owned key is replaced only by its owner with a higher `seq`. Bounded and
    named refusals: `value-too-large`, `store-full`, `writer-quota`, `rate-limited`
    (per sending peer), `lifetime-too-long`, `expired`, `stale-seq`, `owned-key`,
    `not-key-owner`, `unsigned-store`, `bad-auth`, `malformed`; counted, logged with a
    short hash of the key, never the value. A node without a policy ignores the field
    (older nodes too), so nothing an older peer does changes; `owned` mode refuses an
    older writer's unsigned store by name. `StealthAgent` `ownedStores` gives each shard of
    an anonymous agent its own writer key derived from the agent identity (deterministic
    Ed25519 signature), so the shard keys are unchanged and unlinkable, group members who
    hold the lookup nonce read but cannot store, and a signer that is not deterministic is
    refused. Not defended: the sending peer id is the transport's claim; a first-write
    race on a pinned key at a node that has not yet seen the owner's store; replay of a
    captured store after early eviction and before its expiry; nodes without a policy.
- **Announcements.** Discovery records are unsigned. `RelayStrategy` accepts an
  optional `signFn` (off by default; checking is the server's job). Names
  (`MeshNameResolver`) are first-come-first-served, at most 64 characters, 1 h
  default TTL, unsigned. Swarm membership and leader election are
  unauthenticated. `mesh-dht` in `browsermesh-apps` does not authenticate DHT
  messages by default either; with `dhtSignStores` it signs the record it stores with the pod's key, and with
  `dhtStorePolicy` the node checks the stores it receives (both opt-in, `createMeshNode({ enableDht })`).
- **StealthAgent.** The plain `hide()` / `reconstitute()` path is **not
  encrypted and not anonymous**: `threshold` plaintext shards plus XOR parity,
  a checksum that detects corruption but not tampering (defaults 3 of 5; format 3, below, has a real one). With
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
    overwriting a key: by default the DHT still accepts a `store` from anyone, so a
    forged overwrite makes the shard unusable (refused, counted) rather than
    accepted (owned stores, above, stop it on nodes that opt in).
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
    signature, on that path).
  - **shard format 3** (opt-in, `shardFormat: 3` or `[2, 3]`; `design/discovery-records.md`): a
    whole-SHA-256 checksum over the shard's bytes, place, parity code and state length
    (unsigned: a corruption check, not authentication; signed: checked before the signature, so
    damage is counted `shardCorrupt` and forgery `shardBadSignature`) and Reed-Solomon parity
    (GF(2^8), 0x11d, Cauchy) so any `threshold` of `totalShards` shards rebuild the state.
    Parity protects against lost shards, not forged ones, and is not the Shamir key sharing
    (that protects who can read). Records sit under different DHT keys, so an older peer never
    reads one; `[2, 3]` writes both. Not protected: a stale format-2 set can still be read back
    unless readers pass `readFormats: [3]`; the parity code is hand-written (field vectors and
    a second implementation in the tests, no audit); shard size is 4/3 of the bytes.
  - threshold sharing of the group secret (opt-in, `stealth-threshold.mjs`,
    `design/stealth-threshold.md`): the dealer (the owner pod) sees the secret; fewer
    than `t` shares reveal nothing; shares are signed (agent, group, epoch, index,
    holder, threshold) and a share altered, relabelled or from an unnamed dealer is
    refused and counted; a dealer-signed key check catches shares of different
    secrets; epochs are never mixed. Not protected: a compromised dealer, `t`
    colluding holders, share transport (signed, not encrypted), and what a leaving
    member already read (a new epoch re-seals the latest state only).
  - **on-demand share release** (opt-in, `stealth-release.mjs`; `design/discovery-records.md`, item 4):
    a member asks the holders for their shares when it needs the secret, instead of only holding
    shares dealt up front. A request is Ed25519-signed by the member, bound to one holder, a time
    and a nonce, and names the agent only by a hash tag; a holder checks in order size and
    version, addressee and freshness (60 s), a rate limit per requester, the signature, the replay
    cache, **membership against its roster** (a non-member gets the same refusal whether or not it
    holds that agent), then the tag, the epoch floor (`minEpoch`, retired epochs) and an optional
    approval hook, and answers with its signed share sealed (X25519 ECDH, HKDF, AES-256-GCM) to the
    requester and signed by the holder, or a named refusal (`not-a-member`, `replayed`, `stale-request`,
    `rate-limited`, `stale-epoch`, `no-share`, `not-approved`, ...). The reader verifies each share
    against the dealer, `minEpoch` and `holders`, stops at `t`, and reports released, refused and
    unreachable holders; an offline holder does not lower `t`. Logged: outcome, reason, requester pod id
    and 8 characters of the tag, never a share or a key. Not defended: a member (membership is the
    proof; `approve` is where more is added), a holder whose roster is wrong, guessable agent and group
    ids (the tag only keeps names off the wire), colluding holders, a holder that is offline when
    needed.
- **Verified.** Unit, with in-process nodes and a no-op send function. Never over
  a network or in a browser.

## Hosted pods, per lane

Detailed review with the tests that pin each denial and the list of what is not
defended: [`design/hosted-pods-security-review.md`](design/hosted-pods-security-review.md).
Summary:

| Lane | Runs requester code | Boundary | What a pod can reach | Verified |
| --- | --- | --- | --- | --- |
| microVM (Firecracker, `spikes/vm-pod-host`) | yes | hardware (KVM), jailer, cgroups, per-pod network policy | own disk copy only; no host environment; default-deny per-pod network policy (private, loopback, link-local and metadata addresses dropped; no host or other-guest access); distinct VMM uid per VM | unit against fakes; the nft rules are applied to a real Linux kernel (a guest network namespace behind them, `test:real-linux-network`, in CI); the jail and the guest have **never been run on a real host** (`test:real-firecracker` exists and has never run; checklist: [`runbook-firecracker-kvm.md`](runbook-firecracker-kvm.md)) |
| node permission-model process | modules from the host's catalog only | `process` (not a sandbox) | read of the entry file, module and catalog `readPaths`; no write, network or process creation; only the podspec's environment | unit, including denied-access tests |
| node `worker_threads` | catalog modules | `none` | **everything the host can**: files, network, processes, memory (asserted by a test so documentation cannot drift) | unit |
| isolate (Worker / Durable Object spike) | **no**: runs a fixed echo pod | V8 isolate | the Worker's bindings and storage (which holds the pod key); control routes loopback-only with an optional bearer token | unit; no deployment |
| isolate, `isolated-vm` (`createIsolatedVmRuntime()`, optional dependency) | modules from the host's catalog only | language, **in the host's own process** | no `require`, `process`, filesystem, network, timers or `WebAssembly`; one frozen context (`name`, `env`, `input`, `log`); only JSON strings and one log callback cross; heap and per-call time limits that dispose the isolate and report `oom` or `timeout`. A V8 or `isolated-vm` memory-safety bug is a bug in the host process (it can reach everything the host can); the heap limit is a guideline (2 to 3 times is possible); there is no cumulative CPU budget | unit, including escape tests (constructor chains, prototype walks, thenables, re-entrancy, memory and CPU exhaustion); run with the addon's prebuilt binary (no install script, no compiler) on macOS arm64 (Node 26.10), Linux arm64 and x64 on glibc (Debian, Node 26.0.0 and 26.13) and Linux arm64 on musl (Alpine, Node 26.13), and in CI on ubuntu-latest, where a missing addon fails the job instead of skipping. Do **not** start the host with `--no-node-snapshot`: it is not needed on Node 26, and with it the process sometimes aborts at exit (an `isolated-vm` assertion; about 1 run in 10 of the test file on Linux arm64, none in 165 runs without the flag). Never against a real V8 exploit |
| isolate `workerd` | specified only | language | not built | never |
| browser in-page / CDP | yes (a page) | tab / browser context | in-page: no sandbox attribute, a same-origin pod shares the parent's storage; CDP: the browser's network position | unit and fakes; one e2e with headless Chrome for CDP |

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
| HTTP ingress | yes (rules broken once) | in-memory bus; real sockets (hostile client and provider) | yes (two Node peers; the CLI as a child process) | a page as provider, ingress in Node, three browsers | public deployment, TLS in front |
| Egress | yes (rules broken once) | in-memory bus; the real wsh address guard with local sockets; a hostile consumer on the raw channel | yes (two Node peers, local origin, several MiB each way) | a page as consumer: TCP, fetch, UDP, refusals, revocation (`egress.spec.mjs`) | a public destination, NAT or TURN |
| Sync | yes | | | CRDT convergence over a data channel | file transfer over a real link |
| Discovery, DHT, StealthAgent | yes | | | | any network |
| Hosted pods | yes (fakes) | | | | real microVM, Firecracker host, `workerd`; `isolated-vm` against a real V8 exploit |

Not verified anywhere here: anything needing STUN/TURN or a non-loopback
network, the real `browsermesh-servers` relay (the signalling server is run for
real only by the opt-in signalling-server suites, not in CI), service workers,
GPU and IndexedDB in a real browser.
