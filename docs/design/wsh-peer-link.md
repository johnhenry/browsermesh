# wsh as a peer-link transport

Status: implemented in `@johnhenry/browsermesh-transport` (`wsh-links.mjs`,
`wsh-pod-transport.mjs`, `wsh-frames.mjs`) and wired through the peer layer in
`@johnhenry/browsermesh-apps` (`wsh-negotiator.mjs`, `createMeshNode({ wsh })`).
Resolves issue #273 (option 1). Off by default. What it protects and does not:
[`../security.md`](../security.md). Adopting it:
[`../migration-wsh-peer-link.md`](../migration-wsh-peer-link.md). Example:
`examples/18-wsh-sealed-peer-link.mjs`.

## Why

A mesh link today is a WebRTC data channel, a WebSocket, or a relayed
envelope. None of them has what [wsh](https://github.com/johnhenry/wsh)
already has: a key login in both directions, a host key a dialler can pin, a
login signature bound to the connection, and a session sealed end to end so a
relay in the middle can neither read nor alter it. A pod's identity is an
Ed25519 key and wsh's is the same kind of key, so a mesh link can be a wsh
session and the rest of the mesh does not need to know.

## What a link is

A link between pod A and pod B is **one wsh session, sealed, authenticated in
both directions, carrying one named endpoint `mesh`**. The endpoint is a duplex
byte stream with credit based flow control. The mesh's frames travel on it,
length prefixed.

Why a named endpoint and not an `rpc` channel. The reason this note was written
with was that in wsh 0.45.0 an `rpc` channel could not be used on a sealed session
or over a relay bridge (johnhenry/wsh#191). **That stopped being true in wsh
0.46.0**: an `rpc` channel now works on a sealed session and behind a relay. It
no longer decides the matter, and the code was not changed. What still argues for
the endpoint:

* **The shape.** An endpoint is a duplex byte stream with credit based flow
  control, which is what the mesh's length prefixed frames are. An `rpc` channel
  is a stream of structured request, response and notification messages (what
  `wsh-objects` and `mcp` use); carrying frames on it would put a message
  layer under the mesh's own for nothing.
* **The licence.** The key a pod gives a dialler holds exactly `endpoint:mesh`
  (see Authorization below). An rpc protocol is opened with `rpc:NAME`, and one
  that the host did not narrow is open to a key that is not restricted at all; a
  named endpoint is the narrower thing to grant, and cannot be confused with a
  protocol a host added.
* **What it costs to change.** The link is a wire format the other end has to
  speak (an older peer does not see an rpc channel it does not know), so a move
  would need a negotiation for no gain.

Object access and MCP are different: they are rpc protocols (`wsh-objects`,
`mcp`) and they now do work over a sealed session, which is what lets a stock wsh
client reach them on a page host. They are not the mesh link and are not carried
by it; see [`docs/wsh-and-browsermesh.md`](../wsh-and-browsermesh.md). This was not
re-measured here beyond what the repository's own wsh link tests exercise (the
endpoint, on wsh 0.45.0 to 0.48.0).

```
 pod A (wsh client)                 pipe relay                 pod B (wsh host)
 ------------------                 ----------                 ----------------
 dials  /r/<rid(B)>   ---------->  pairs by id  <----------   waits /r/<rid(B)>?role=host
 expects host key = key(B)  (pin)                              authorizes key(A) (callback)
 key login as podId(A)                                         checks username == podId(key)
 sealed session (X25519 + ML-KEM-768, both halves signed)
 openEndpoint('mesh')  <================ ciphertext ===============>  endpoint handler
```

The relay copies bytes and holds no key. It sees who dials which rendezvous
id, when, and how many bytes; it cannot read, alter, replay or inject anything
without ending the link.

## Identity

* A pod's Ed25519 key **is** its wsh identity. `PodIdentity.keyPair` signs the
  wsh login and the wsh host proof. A signer `{ publicKey, sign }` can be given
  instead (a key held in a vault or wallet; see issue #266), so the private key
  never has to be readable.
* pod id = base64url(SHA-256(raw public key)); wsh fingerprint = the same hash
  in hex. The conversion is a re-encoding of the same 32 bytes
  (`podIdToFingerprint`, `fingerprintToPodId`: one implementation, in
  `@johnhenry/browsermesh-primitives`, and `wsh-links.mjs` re-exports them).
  `MeshWshBridge` uses the same two functions (it stays as the helper that
  syncs a `WshKeyStore` with a `MeshIdentityManager`; the link layer does not
  need it).
* **The pod id a peer claims must equal the hash of the key wsh authenticated.**
  The wsh login carries a username and signs a transcript that includes it. A
  dialler logs in with `username = "pod_" + its pod id` (wsh accepts only user
  names that start with a letter or underscore, and a base64url pod id may
  start with a digit or a dash). The host refuses unless
  `username === "pod_" + fingerprintToPodId(fingerprint of the key that signed)`
  (`identity-mismatch`). The other direction is the pin: the dialler passes
  `expectHostKey = podIdToFingerprint(the pod id it meant to reach)`, so a host
  whose proven key hashes to anything else is refused before the dialler sends
  a credential.
* Consequence: on a link, **the sender of every message is the authenticated
  key of the session**. The link layer overwrites `from` with that pod id and
  drops a message whose own `from` or `podId` field names someone else. No field
  inside a message is ever the source of the sender's identity.

## Who is host and who is client

Neither browser can listen. A pod that wants to be reachable **listens**: it
dials the relay as the *host half* of a pipe at its own rendezvous id

    rid(podId) = base64url(SHA-256("browsermesh-wsh-link/1:" + podId))   (43 characters)

and serves whoever the relay pairs it with as a wsh host (`createMemoryHost`
with `hostKey` = the pod key, `sealSession: 'require'`,
`requireChannelBinding: true`, `dataStreams: false`, one endpoint `mesh`). A pod
that wants to reach `B` **dials**: it connects to the relay as the *operator
half* at `rid(B)`, as a wsh client (`expectHostKey` = key of B, key login,
`sealSession: true`, `requireChannelBinding: true`).

A pipe relay pairs one host half with one operator half, so a listening pod
keeps `listenSlots` (default 2) host halves waiting and tops one up as soon as
one is paired. The rendezvous id is derived from a public value; it is not a
secret and the design does not rely on it being one. What stops an impostor who
reaches the id first is that the dialler pins the host key and the host
authenticates the dialler. An impostor can occupy a waiting slot (a nuisance,
handled by keeping slots topped up); it can not become B.

Why the pipe relay and not relay (reverse host) mode: in relay mode the relay
stamps the operator's identity on messages and is a party to the bridge (wsh
documents that only control messages cross it), so it would need the operator
proof and sealed bridge options on top. A pipe relay vouches for nothing, and
named endpoints work through it on a sealed session (tested here).

Non-browser pods (Node) may also listen directly (`createWshServer`) and be
dialled without a relay; the hub takes a `socketFactory` so a direct URL or a
test socket can stand in for the pipe URL. (A direct listener is not part of
this release's tests beyond the socket factory seam; see "Not done".)

### Simultaneous dial

If A and B dial each other at once there are two sessions. Every side sees
both and applies the same rule: **keep the link whose initiator has the smaller
pod id** (byte order of the base64url string, which is hash order). The other
is superseded: its sender stops, it is closed after it drains, and nothing is
reported as a peer going down. Two sessions with the same initiator (a
redial racing an old link that has not been noticed as dead) keep the newer.
Exactly one link survives, on both sides, without a message between them.
Messages in flight on the superseded link are still delivered; order across
the switch is not guaranteed.

## Frames

Each frame on the endpoint is `u32 big-endian length | u8 kind | payload`,
where `length` counts the kind byte and payload.

* kind `0`: binary payload, kind `1`: UTF-8 text payload. Objects are sent as
  JSON text, strings and binary unchanged (the rule every adapter in this
  package already follows: `encodeWireData`).
* `maxFrameBytes` (default 1 MiB) is checked on the **header**, before any of
  the payload is buffered. A header above it, a zero length, or an unknown kind
  ends the link (`frame-too-large`, `bad-frame`). Sending a frame above the
  limit is refused locally with `WSH_FRAME_TOO_LARGE`.

## Flow control and backpressure

* Writes await the endpoint's credit window (256 KiB per direction, topped up
  as the reader consumes). `send()` returns a promise that resolves when the
  stream accepted the frame, which is the shape netway #267 asks of
  `write()`.
* Sends are queued in order; the queue is bounded by `maxQueuedBytes` (default
  4 MiB). A send that would exceed it rejects with `WSH_BACKPRESSURE` instead
  of growing memory. The pod adapter (whose `send()` is fire and forget) drops
  the message and emits `dropped`.
* The reader does not pull the next frame until the handler it called has
  returned (and, if it returned a promise, settled), or while the link is
  `pause()`d. A slow reader therefore stops granting credit and the sender
  stalls at a bounded amount: the window plus the queue.

## Liveness, reconnect, close

* Liveness comes from wsh: the client pings and closes on a missed pong
  (`keepAlive: { pingIntervalMs, pongTimeoutMs }`); when it does, the relay
  closes the other half and the host sees the endpoint end. (The tests drop
  sockets; none makes a relay go silent, so the ping timeout path itself is
  wsh's and is not exercised here.)
* `peer-down` carries a reason: `closed`, `seal-failed` (a frame did not open),
  `frame-too-large`, `bad-frame`, `superseded` (never reported as down),
  `transport` (the socket dropped), `local-close`.
* A peer asked for with `connect(podId)` is **kept**: after an unplanned
  `peer-down` the hub redials with exponential backoff (`reconnect:
  { baseMs: 250, maxMs: 10000, maxAttempts: Infinity }`, the shape
  `WebSocketTransport` in `browsermesh-pod` uses). A refusal or a host key
  mismatch stops the redial: those do not get better by retrying. The
  listening side re-registers its waiting halves the same way when the relay
  drops.

## Errors

Every failure is a `WshLinkError` with a stable `code`:

| code | meaning |
| --- | --- |
| `WSH_HOSTKEY_MISMATCH` | the host proved a key that is not the pod id that was dialled |
| `WSH_REFUSED` | the host refused this pod (`reason` is wsh's `onRefused` reason: `unauthorized`, `not-sealed`, `binding-required`, `bad-signature`, `key-expired`, `not-permitted`, ...) |
| `WSH_NOT_SEALED` | the session is not sealed (a host that cannot or will not seal is refused before a credential is sent) |
| `WSH_UNREACHABLE` | no relay reachable, or nobody answered in `connectTimeoutMs` |
| `WSH_SEAL_FAILED` | a sealed frame did not open |
| `WSH_FRAME_TOO_LARGE`, `WSH_BAD_FRAME` | framing limits |
| `WSH_BACKPRESSURE` | the send queue is full |
| `WSH_CLOSED` | the link is closed |
| `WSH_UNAVAILABLE` | `@johnhenry/wsh` is not installed, or there is no WebSocket constructor |

On the dialling side a refusal is `WSH_REFUSED` with `reason: 'unauthorized'`
(wsh tells a dialler only that authentication failed). The host knows why and
reports it through `onRefused` / the `refused` event, with the precise reason.

`onRefused` on the hub is wsh's callback passed through (and re-emitted as the
`refused` event), with `identity-mismatch` added for the one refusal wsh cannot
know about.

## Selection: off by default, never a silent downgrade

* Nothing changes for code that does not ask. `'wsh'` is a new member of
  `TRANSPORT_TYPES`; it is **not** in the default preference order
  (`webrtc`, `wsh-wt`, `wsh-ws`; the last two are plain WebSocket and
  WebTransport and have nothing to do with the wsh protocol; the name is
  historical).
* To use it: construct a `WshPeerLinks` (identity, relay URL(s), `authorize`),
  register `negotiator.registerAdapter('wsh', factory)` and either put `'wsh'`
  in `preferenceOrder` or pass `require: 'wsh'`. `TransportFactory.create('wsh',
  { links, peerPodId })` returns an unconnected link for the same purpose. A
  `Pod` takes `WshPodTransport` as its transport; a mesh node takes
  `createMeshNode({ wsh: { relays } })` (with `require: true` for the
  fail-closed setting). There is no option literally named `transport: 'wsh'`:
  the negotiator's preference order is the registry's way of choosing adapters.
* `PeerNode.connectToPeer()` used to fall through to a transportless registry
  connection on any negotiation failure; it now rethrows when its negotiator was
  told to `require` a transport, so `require: 'wsh'` holds at the peer layer too.
  `require` governs outbound connects only: inbound WebRTC offers are still
  answered while a WebRTC signaling bus is wired.
* **`require`** (constructor option or third argument of `negotiate`) means:
  only that adapter is tried and its failure is the failure. There is no
  fallback to anything unsealed. Without `require`, a preference order that
  lists `'wsh'` ahead of another adapter falls through to it, and that is a
  choice the caller made by listing it.
* **Sealing is not an option.** The link layer always seals (`require` on the
  host, `true` on the client) and verifies `client.sessionSealed` after login.
  There is no setting that makes a wsh link plain.

## Authorization

The host calls `authorize({ podId, fingerprint, publicKey })` after the key's
signature verified and before any endpoint is opened, so a refused key never
gets as far as a mesh frame. The default is to refuse everyone. The answer may
be `true`, `false`, or `{ expires }`; the key is never given anything but the
`endpoint:mesh` capability (wsh's per-key `capabilities`), so even a bug in the
link layer cannot hand a peer an exec channel or a gateway on this host.

`@johnhenry/browsermesh-apps` provides `createWshAuthorizer(registry)`, which
asks `PeerRegistry`: a peer is allowed when
`checkAccess(podId, 'mesh:link', 'connect')` passes (the ACL scope
`mesh:link:connect`; `MeshACL` wildcards apply, and so does revocation). A peer
with no grant is refused. `requireKnownPeer: true` additionally requires the
peer to be in the registry's peer list.

## Peer layer wiring

`PeerNode` ties `fromPubKey` to a session through whatever the transport
factory reports. For wsh the factory reports **the key wsh authenticated**:
`connectToPeer(pubKey, { wsh: pubKey })` fails with `WSH_HOSTKEY_MISMATCH` if the
host is anyone else, and an inbound link is adopted
(`adoptIncomingSession`) under the pod id derived from the authenticated key.
Every mesh message above the transport (pod messages, `mesh-rpc`, `mesh-sync`,
`mesh-relay`, ...) rides `sendTo()` / `onIncomingData()` as before and is
unchanged.

## What this does and does not protect

Protected, between two pods that both run the link layer:

* **Confidentiality and integrity against the relay and the network.** After
  the key exchange every byte is an authenticated encrypted frame (strict
  counter, role tag); a relay that flips a byte, replays or reorders a frame, or
  injects a plain one ends the link, and nothing forged is delivered.
* **Peer authentication bound to the pod id**, in both directions, with the
  dialler pinning the host and the host consulting the registry.
* **Channel binding**: the login signature covers the host key, so a login
  cannot be replayed at another host.

Not protected:

* **Traffic analysis.** The relay sees who dials which rendezvous id and when,
  and the size and timing of every record. `padding` / `jitterMs` of
  `WebSocketTransport` are not applied here; frames are not padded.
* **The handshake before login**: the login username (the pod id), the login
  public key and the host key proof are readable by the relay. They are not
  secrets (the pod id is public by design).
* **A compromised peer.** The link proves whose key, not whose hands.
* **Denial of service.** A relay can always drop, delay or end a link, and
  keep a rendezvous slot busy.
* **A message forwarded onward by a peer over some other, unsealed link.**
  End to end protection ends at the peer that terminates the link. If B
  forwards what it got from A to C over a WebRTC data channel, or a
  `MeshRelayHost` relays it, A's guarantee covers only A to B. At the link
  layer a forwarded message is distinguishable: a message that arrives on a
  link carries `from` = the link's authenticated peer, and a message whose own
  `from`/`podId` names a third pod is **dropped** (reason `foreign-sender`),
  never delivered with the third pod's name. At the application layer
  (`mesh-relay`, `mesh-rpc` forwarding) a forwarded payload is data inside an
  envelope from the forwarder; the application sees B as the sender and must
  treat the inner claim as B's claim. A multi hop path is as strong as its
  weakest link, and nothing marks which links were sealed.

## What `browsermesh-servers` would need (not part of this repository)

Nothing is filed and no code there is changed. For browser to browser links
through the mesh's own relay:

1. **A pipe relay route** next to `register` / `relay` / `relayed`: a WebSocket
   upgrade at `<base>/r/<rendezvous id>` and `<base>/r/<id>?role=host`, backed by
   `createPipeRelay()` from `@johnhenry/wsh/pipe-relay` (`relay.accept(socket,
   { id, role })`). The module imports nothing that executes code or reads files
   and works on any runtime with a WebSocket-like socket.
2. **State per rendezvous id** that survives until paired: in a Worker
   runtime that means one Durable Object (or equivalent) per id holding the
   two sockets. The pipe relay's own bounds apply and should be set:
   `maxWaiting`, `rendezvousTimeoutMs`, `idleTimeoutMs`, `maxLifetimeMs`,
   `maxBytes`, `maxMessageBytes`, `highWaterBytes`.
3. **Binary frames only, opaque.** The existing relay is a JSON protocol that
   parses each message; the pipe route must not parse and must not log
   payloads.
4. **Admission without identity**: the relay's `authorize({ id, role, remote })`
   hook is the place for origin allow-lists and per-IP / per-id rate limits. It
   cannot vouch for who connects; it only limits abuse.
5. **TLS** (`wss://`) on the route, and CORS / Origin policy appropriate for a
   page opening the socket.
6. Nothing else: no pod registration, no key handling, no message routing.

Alternative that needs no server change: carry the pipe's bytes inside the
existing `relay` / `relayed` envelopes (base64 in JSON) through a
`socketFactory` that implements a WebSocket-like pair over those envelopes.
It costs about a third more bytes, needs the pod's relay connection shared
with the pod's own `WebSocketTransport`, and has not been built here; the
`socketFactory` seam is where it would go.

## Bundle size

`@johnhenry/wsh` is `sideEffects: false` with one entry point per role, and
is imported lazily (`import()` with a literal specifier on first use, so a
bundler splits it into chunks a page that never links over wsh never fetches).
The dialling role imports `@johnhenry/wsh` (the client); the listening role
imports `@johnhenry/wsh/memory` (the host). The in-process test relay is a
separate subpath (`@johnhenry/browsermesh-transport/wsh-in-process`) because it
imports wsh's pipe relay, which has a Node-only listener.

Measured with esbuild (minified, browser, splitting), wsh 0.45.0: a page that
uses no wsh link pays +0.56 kB raw / +0.16 kB gzip in the main chunk (the
`'wsh'` factory case); a page that imports `WshPeerLinks` has 21.1 kB raw /
7.8 kB gzip of link code; lazily, the dialling role adds 170.6 kB raw / 52.8 kB
gzip, the listening role 237.4 kB / 74.5 kB, both 259.2 kB / 82.9 kB, plus
19.2 kB / 7.6 kB for `@noble/post-quantum` where WebCrypto has no ML-KEM. The
repository does not otherwise measure or budget sizes.

## Dependency

`@johnhenry/wsh` is an **optional peer dependency** of
`@johnhenry/browsermesh-transport` (and a dev dependency for tests), at the
version range that was tested: `>=0.45.0 <1.0.0`. The transport's wsh tests (116: link, lazy loading,
identity; the real handshake over the in-process pipe relay) and example 18 were
run against 0.45.0, 0.46.0, 0.46.1, 0.47.0 and 0.48.0 and pass on each; nothing
newer has been tried (wsh is 0.x and breaks between minors, so a release past
0.48 should be run through the same tests before it is relied on). The range was
`^0.45.0`, which for a 0.x version excludes every later release and made a
current wsh a peer conflict. Optional peer because the transport package is used by many consumers
that never use wsh, the import is lazy, and a consumer that asks for the wsh
transport without installing wsh gets an error that says what to install.

## Not done

* A direct (relay-less) Node listener through `createWshServer` is possible
  through the `socketFactory` / accept seam but has no test or example here.
* `padding` and `jitterMs` for wsh links.
* The in-band pipe over existing relay envelopes (above).
* Anything in `browsermesh-servers`.
