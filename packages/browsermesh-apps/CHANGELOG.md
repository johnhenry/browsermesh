# Changelog

## 0.30.2

### Patch Changes

- cb4e1e3: The first request after a pod starts over is answered instead of being cut with a 502 `provider-closed`. A visitor's request can reach the ingress after the pod's new connection has been answered and before the ingress has been told the pod started over, so it is sent on the old link; the link then ends (the send on the swapped connection fails, or the restart is reported) and the request ended within a few milliseconds. The ingress now sends such a request once more on the new link when it had no answer byte, was not streaming a body, and is a method that may be repeated (`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`; a request that never left may also be any other method with no body). It is on without `retry`, `retry.nonIdempotent` does not widen it, and an answer that has begun is never sent again. Nothing new on the wire; an older pod is sent the same request it would have been sent.

  `@johnhenry/browsermesh-apps`: `link.request(method, params, { onSent })` (and the protocol channel's `request`) calls `onSent` once the transport has taken the first frame of the request, so a caller can tell a request that never left from one that may have reached the peer. Additive; a peer that does not pass it is unchanged.

## 0.30.1

### Patch Changes

- 9a94119: The optional peer range on `@johnhenry/browsermesh-transport` is now `>=0.13.1 <1.0.0` (was `>=0.6.0 <1.0.0`): 0.13.1 is the first transport that passes `authorize(peer, { restricted: true })`, which link admission over wsh needs. The fail-closed negotiation in `createWshAdmissionAuthorize` stays for a transport outside the range.

## 0.30.0

### Minor Changes

- 85f6c60: `createMeshNode({ realm })`: a node hosts and joins one realm. The realm exchange (descriptor store, verifier, prover) is wired through the existing link-admission seam for wsh and WebRTC, `node.realm` carries `present()`, `renew()`, `status()` and `setCredential()`, a `realm` protocol on the protocol seam renews a grant (and delivers descriptor updates) to a peer that holds a live grant, and an optional `autoRenew` timer re-presents before `notAfter`. The realm package is an optional peer dependency, `import()`ed lazily; without the option nothing changes.

### Patch Changes

- 13f580d: A restricted link's `send()` (link admission) returns a promise that never rejects: `true` once the transport accepted the frame, `false` if the transport failed or the link is closed, including a send after the deadline or after the peer left. A handler that fires and forgets a send no longer risks an unhandled rejection when the link closes. Programmer errors (a send after `promote()`, a frame over `maxFrameBytes`) still throw synchronously.
- 10ec46c: Two gaps around a peer that starts over on a WebRTC connection this node already holds. First, a peer that went away without a close this side had seen yet (its channel closing, or its state failed) left a connection that was held and handed to the node but not open, and the negotiator told the node `restarted` only for an open one: the fresh offer swapped the connection underneath, nothing reported the old one closed, and the channel link over it stayed up for a node that remembers nothing of it. A connection is now held when it is open or was handed to the node and has not closed since, and a renegotiation (an ICE restart, whose answer says so) keeps the channel and what runs over it and is no longer reported as a restart. Second, a peer that speaks the moment the connection is up (the opening frame of a channel it opens at once, as a running ingress does after a restart) could be heard by nobody, because the node listens to the connection only once it has built the session around it, a little after the connection opens: its opening frame was dropped and the channel waited out its open timeout. The adapter the negotiator hands out now holds what arrives (up to 64 frames) until its first listener and gives it to that listener in order. Nothing is added to the wire and no option or default changes: an older peer is served as before.
- f9045d5: A peer that speaks the moment its connection is up is no longer unheard. With identity binding on (the default), a peer that has sent its proof and then sends a frame at once (the opening frame of a channel it opens, as a pod does when it starts again against a running ingress) was dropped and counted in `droppedUnbound` whenever this side had not finished verifying that proof: the other side verifies this side's proof first, so it is up and talking before this side is. In transport, `WebRTCPeerConnection` now holds what a peer sends after its proof and before the proof verified (up to 64 messages), delivers it in order once the proof verified, and discards it if the proof does not verify; a message that arrives before any proof is still dropped and counted, as before. In apps, the negotiator makes the transport adapter before the connection can carry a frame (for an answered offer and for a dial), so the held messages have a listener to reach, and for a peer that starts over on a connection this node still holds, what the new connection carries is held until the node has been told of the restart, so the restart can never end the link the new connection has just opened. Nothing is added to the wire and no option or default changes. An older peer is served as before; an older transport under this apps still drops what arrives before the proof verified.

## 0.29.1

### Patch Changes

- 21ef78b: Link admission fails closed against an older transport. `createWshAdmissionAuthorize` returns `{ restricted: true }` only when called as `authorize(peer, { restricted: true })`, which the transport now does; a transport that calls `authorize(peer)` and grants a full mesh link on any truthy verdict gets `false` for a `restrict` decision instead (reported through the new `onEvent` option, which `createMeshNode` logs). `createMeshNode({ admission, wsh })` logs `mesh-bootstrap:admission-restricted-unsupported` when the loaded `WshPeerLinks` lacks `supportsRestrictedAdmission`.

## 0.29.0

### Minor Changes

- 47c9898: `createMeshNode({ identity: { podId } })` adopts an identity that already exists in the supplied `identityManager` instead of creating a new one, so a page can keep its key across a reload. It throws if the pod id is not in the manager, if no `identityManager` is given, or if the option is malformed. The adopted identity becomes the manager's default (what `node.podId` reports). Without the option nothing changes.
- 49160a3: `PeerRegistry` gains a realm grant source, a prerequisite for realms (`docs/design/realms.md`).

  - **A separate source, not the operator's slot.** `grantRealmScopes({ realmId, serial, peerKey, role, scopes, notAfter, epoch })`, `revokeRealmGrants({ realmId, peerKey | serial | belowEpoch })`, `listRealmGrants()` and `setRealmPolicy()`. `checkAccess()` allows if the operator's grants allow or a live realm grant covers the scope, so a realm's renewal, expiry or revocation can no longer extend, shorten, poison or delete a grant the operator made. Realm grants are keyed by (realm, role, peer), carry their own expiry and epoch, and are never written by `toJSON()` nor restored by `fromJSON()`.
  - **Host policy decides.** New `realmPolicy` and `onRealmGrantDropped` constructor options. The default honours no realm, so nothing changes for existing users. A role scope outside the host's allow list is dropped and reported; `egress:`, `ingress:`, `pod-host` and `wsh-` scopes are granted only if a pattern in the allow list begins that way; a wildcard or short scope is refused.
  - **Events.** Added, replaced, removed and expired realm grants announce through `onAccessChange` (`realm-granted`, `realm-replaced`, `realm-revoked`, `realm-policy`, `expired`), and expiry shares the registry's one timer.

- 0ec7933: A request in flight when a pod is torn down in the README's order is ended at once with a status and a reason, instead of waiting for its deadline. `serveHttpOnMesh(...).stop()` now returns a promise that resolves once the close notices of its `http` channels have left the pod (it used to return before they were sent, and the node's close that followed lost them, so the ingress was never told); `await` it before closing the node (README, "Closing a pod: the order", now says so). New option `stop({ graceMs })` (default 0, unchanged behaviour: end everything now) lets the requests being answered finish first, for at most `graceMs`; a request that arrives meanwhile is refused and the visitor gets 503 `provider-stopping` (new reason, with `Retry-After`; an older ingress shows it as 502 `provider-failed`). `openNameClient(...).close()` also waits for its channel's close notice. Apps: a protocol channel's `close()` returns a promise that settles (never rejects) once the notice to the other end has left; callers that ignore the return value are unaffected, and an older apps gives `undefined`, which `stop()` and `close()` accept (they then have nothing to wait for).
- 8a062dd: Link admission: `createLinkAdmission({ maxRestricted, deadlineMs, maxFrameBytes, decide, handler, onEvent })` (a restricted state for links whose peer is not yet known: cap, deadline, one-shot promote/close, frame cap, counters) and `createWshAdmissionAuthorize`. `createMeshNode({ admission })` gates inbound WebRTC sessions through `decide` (reporting `proven: false` for a link whose key the identity binding did not verify) and, with `wsh`, admits unknown wsh peers to a restricted link; `node.admission` is the seam. Opt-in: without the option nothing changes.

### Patch Changes

- c7c6cda: A node whose peer starts over on the WebRTC connection it holds open (a fresh offer for an open connection: a page loaded again, a node made anew) now ends the channel link that ran over the old connection. Before, the link stayed: a restarted pod that only serves (a hand `--map` at the ingress, no name claimed) sends no hello of its own, so the ingress went on sending over a link the new node knows nothing of, and every request waited out the open timeout for a 504 `provider-timeout`. Now the requests on the old link end at once (502 `provider-closed`) and the next request opens a new link on the new connection. `onIncomingConnection` gets a fourth argument `{ restarted }`, `adoptIncomingSession` takes `{ restarted }` and emits `peer:transport-restart`, and the mesh channel service follows it. Nothing is added to the wire: an older pod is served as before, and an older ingress behaves as it did. The ingress README says so.

## 0.28.0

### Minor Changes

- fc52951: Links follow their connections, a restarted peer is one link, and two peers that dial each other at once converge on one connection.

  - **One connection, one session.** A peer that starts over on a connection this side still holds (a fresh offer swaps the connection underneath; the transport object stays) is wired in once. The WebRTC negotiator keeps one transport adapter per connection and `PeerNode` one session per transport object; before, every start added a session over the same object and every inbound message was delivered once per session, so the second copy of the end of a stream ended the link. A session whose transport reports its close and is finished (`state === 'closed'`) is no longer active: `hasActiveSession` and `sendTo` stop counting it. A transport that drops and redials itself (a wsh link) and one that does not say its state keep their session, as before.
  - **A link ends with its connection.** `createMeshChannelService()` closes the link to a peer (`transport-closed`, and with it every protocol channel on it) when the node reports that the transport to the peer closed and the peer has no other active session, where it used to stay open until a request or a timeout found out. A node without `on` and `hasActiveSession` (a test double) is left as it was. A peer that was killed outright is therefore noticed as soon as the operating system tells the transport its connection is gone, where only the keep-alive noticed it before: a consumer of `browsermesh-egress` then sees its link end as `provider-closed` instead of `provider-gone` when the transport reports first.
  - **A frame carries its link.** Every channel frame has the session id of the link it belongs to (`sid`); a frame for another link than the one held is dropped, so the late close of a replaced link cannot end the link that replaced it. A frame without an id (an older peer's) is accepted as before, and an older peer ignores the field.
  - **Glare.** When `connectToPeer()` has an offer out and the peer's offer arrives, the lower pod id's offer wins: the other side drops its own, answers, and its dial resolves with the connection that opens. Offers carry `glare: 1`; an offer without it is from a release that always gives way, so the newer side's offer wins against it. A winner whose offer may never have reached a peer that was not there yet sends it again once after `GLARE_RESEND_MS` (1.5 s) if no answer has come. New exports `GLARE_VERSION` and `GLARE_RESEND_MS`.

  What an older peer does: an older peer that dials a newer one at the same moment is answered and linked whatever the ids (its own `connectToPeer()` may report an answer timeout after the link is up); a newer peer's restarts are served whatever the other side runs; an older peer that is the one that keeps running (the ingress) still wires a restarted peer in twice, and two older peers behave as before.

## 0.27.0

### Minor Changes

- 4af3c21: The mesh relay (`MeshRelayHost`, `createMeshRelayBackend`) passes a half-close through. A client that has finished sending (`socket.end()`) still gets the answer the service sends later, and a service that finishes first still receives what the client sends after it; an end of stream used to be a full close in both directions. A new `end` frame ("no more from me") carries it, negotiated: `connect` and `ok` carry `halfClose: true` and only a connection where both sides said so uses `end`. An older peer is never sent one and keeps the full close: an older host answers `ok` without `halfClose`, and an older client's `connect` has none. An application that closes or destroys its socket still closes the connection in full.

  New option `halfCloseIdleMs` (host and client; default 300000, matching wsh's; 0 = never): a connection that is half-closed and has had nothing moving in either direction for that long is closed with the reason `idle timeout`, and its `maxConnectionsPerPeer` slot is free again. Between two current peers, a service that never closes its side when it reads the client's end of stream now keeps the connection for up to that bound where it used to be closed at once.

## 0.26.0

### Minor Changes

- 34687ff: The DHT that `createMeshNode({ enableDht })` runs can now store under the pod's own key and check what it is sent, both opt-in.

  - **discovery:** `DhtDiscoveryStrategy` takes `storePolicy` (handed to its `DhtNode`), `now`, `signStore(key, record)` (called by `announce` to sign the record it stores; a signer that throws stores nothing) and `onStoreRefused`; `strategy.storePolicy` and `dhtNode.storePolicy` report what is in force. With none of them the strategy is what it was.
  - **apps:** `createMeshNode({ enableDht, dhtSignStores, dhtStorePolicy, dhtStoreLifetimeMs })` and `createMeshDht({ signStores, identity, storePolicy, storeLifetimeMs })`. `dhtSignStores` signs the record the node announces with the pod's key (a `seq` that rises with every announce, an expiry 24 h ahead by default); `dhtStorePolicy: 'open' | 'owned'` makes this node check the stores it receives (`'owned'` holds only records that carry a valid proof, and needs `dhtSignStores`). Off by default. A node that does not check ignores the proof, so signing is safe in a mixed swarm; an `'owned'` node does not hold a record from a node that does not sign. With an older discovery package that ignores these options, `createMeshDht` throws instead of quietly storing unsigned.

## 0.25.0

### Minor Changes

- b2144a1: Two additions, both additive.

  - `@johnhenry/browsermesh-apps/lean-node`: `createLeanMeshNode(options)`, the smallest connected node (identity, a default-deny
    registry, WebRTC and signalling, no services), for a page that only has to reach one pod. It takes the options of
    `createMeshNode` that mean the same thing and returns the same kind of node; `attachService` and `createMeshProtocolService`
    are re-exported from it. Its static imports are named, so a bundler keeps a fraction of what the package root pulls in. The
    package root and `createMeshNode` are unchanged.
  - A protocol channel closed with a short plain-text reason tells the other end why: the `mesh.protocol.close` notification carries
    an optional `reason`, and the other end reads it as `channel.remoteReason`. A peer that predates the field ignores it.

  Also fixes the WebRTC negotiator leaving a timer waiting for an answer to an offer that never left (the signalling transport threw
  while sending it): the wait is now cancelled.

## 0.24.0

### Minor Changes

- 2055c23: Hosted pods can sleep and wake by use (cold boot as sleep). `@johnhenry/browsermesh-pod` adds `createHibernatingDriver(innerDriver, opts)`, a `PodHostDriver` wrapper: a pod idle for `idleMs` is drained to a record in a `HibernationStore` (podspec and `podId`) and reports `state: 'cold'` with `sleeping: true`; a `send`, `exec` or `deliver()` boots it again within `wakeTimeoutMs`, concurrent callers sharing one boot in order, bounded by `maxQueuedPerPod` and `maxConcurrentWakes`. A sleep sends no `exit` event, so a supervisor restarts nothing; `status`, `list` and `drain` never wake a pod; a wake fails rather than bring up a pod with a different `podId`. `PodHostDriver.spawn(spec, options)` takes an optional second argument (`{wake: {discoveryWindowMs}}`) that drivers may ignore. Also exports `MemoryHibernationStore`, `HIBERNATION_DEFAULTS`, `HIBERNATION_REASON` and `WAKE_FAILURE`.

  `@johnhenry/browsermesh-apps`: a pod-host `describe()` now carries `hibernation` (the host's policy, or `null`); `createHostPool({ overcommitSleeping })` (default `false`, which changes nothing) lets a sleeping pod free its cpu and memory in the ledger while still counting as a pod and toward the requester quota, and refuses a wake that would not fit (`EBUSY`, `wake-refused`).

  Nothing is on by default and nothing on the wire changes except the optional `sleeping`/`waking` status fields and the `hibernation` description field; an older client ignores them and sees a sleeping pod as `cold`. Not run against a real Durable Object.

- abbd00e: A supervised pod can be placed, and re-placed after every exit, by the placement planner under the requester it was supervised for. `createPodSupervisor().supervise(host, spec, { requesterId, minBoundary })` records the requester; with either option stated, `'auto'` and every restart ask the planner (`MeshOrchestrator#decidePod()`, new: the decision and audit of `placePod()` without the spawn, or an injected `placer`), under that requester's trust and never the supervisor's own identity, preferring the current host or avoiding a lost one. If that requester's rules no longer allow any host, the supervisor emits `supervisor:replacement-refused` and `supervisor:gave-up` with the reason `replacement-refused:<plan code>`, audits both (`supervisor_replacement_refused`), spawns nothing and leaves the pod `dead`; `EBUSY` is retried as before. Without either option nothing changes (`pickHost`, `pickAutoHost()`, a restart on its own host). `list()` reports `requesterId` for such pods.

  `meshctl pods supervise auto` accepts `--requester <pubKey>` and `--min-boundary`, as `pods spawn auto` does, with the same validation, and hands placement and restarts to the planner under that requester.

### Patch Changes

- 5ab097b: Documentation and code comments no longer point at the Manifest V3 extension spike, which has been removed from the repository (it never ran in a real browser). The browser lane has two drivers: in-page and CDP. No behaviour changes.

## 0.23.0

### Minor Changes

- 8d7f22c: `createMeshNode()` accepts `maxHalfOpenInbound` and `halfOpenTimeoutMs` and passes them to its WebRTC transport factory
  (as `createWebRTCTransportFactory()` already took them). Leaving them out keeps the factory's defaults (64 connections,
  60 000 ms); `Infinity` turns either bound off.
- 675366a: `createStreamLayer` accepts `maxViolations` and `onAbuse` (off unless `maxViolations` is given): the rules a peer breaks
  on its streams (data out of sequence, past its credit, past the chunk or stream size, without bytes) and the opens that
  are refused for a reused or invalid id or for being past `maxStreams` are counted across all streams of that peer, and a
  peer that goes past the budget is cut off: every stream fails with `stream-abuse`, `onAbuse` is called once, later opens
  are refused and nothing further it sends is processed or answered. New `violations` and `abused` on the layer.
  Receive-side only: no frame on the wire changes, so an older peer is unaffected, and behaviour without `maxViolations`
  is as before.

## 0.22.0

### Minor Changes

- 9846f2a: The WebRTC negotiator now bounds inbound connections that are still connecting: at most `maxHalfOpenInbound` (default 64) answered-but-not-yet-open connections at once, each closed after `halfOpenTimeoutMs` (default 60 s) if it has not
  opened. A further offer closes the oldest unfinished connection to make room; a renegotiation offer for an open
  connection takes no slot. `Infinity` turns either bound off, and `createWebRTCTransportFactory(...).halfOpenInbound`
  reports the live numbers. Nothing on the wire changes, so an older peer is unaffected. An inbound offer whose answer
  fails now also closes its half-built connection instead of leaving it in the manager.
- 36d2845: A held join for a peer registry, opt in: `createOfferingJoinGate({ registry })` and `createJoiningJoinGate({ install })`.
  The offering side approves a request, the joining side keeps it, and nothing is added to the registry (or installed on the
  joining side) until both have happened. An approval that is not kept runs out (default 5 minutes on both sides, with 10 s
  more on the offering side for the message to arrive), so does a request nobody answers, and either side can leave at any
  point. Waiting joins are bounded (`maxWaiting`, default 16). State machines with an injected clock: no UI and no wire
  messages, and nothing else in the package uses them, so existing behaviour and older peers are unaffected.

## 0.21.2

### Patch Changes

- 4fa5f2a: The transport's main entry no longer reaches wsh, so an application that does not use wsh can bundle or vendor it for a browser.

  - The wsh peer links, services, relaying pod and pod transport (`WshPeerLinks`, `WshLink`, `WshLinkError`, `createWshTransportFactory`, `WshServices`, `WshRelay`, `WshPodTransport`, `connectWshServicesOverMesh`, `connectWshServicesViaRelay` and the rest of `wsh-links`, `wsh-services`, `wsh-relay`, `wsh-pod-transport`) now live at the new subpath `@johnhenry/browsermesh-transport/wsh`. The import graph of the main entry holds no `@johnhenry/wsh` specifier and no Node-only module; a test pins it, and the browser suite imports the entry in a page whose import map has no wsh.
  - `TransportFactory.create('wsh', { links, peerPodId })` builds the link through `links.link(peerPodId)` instead of importing the link class.
  - `./wsh-in-process` (the Node-only test relay) now has only a `node` export condition; a bundler for the browser cannot resolve it.
  - `podIdToFingerprint`, `fingerprintToPodId` and `podIdFromRawKey` stay on the main entry (re-exported from primitives).
  - The optional peer range for `@johnhenry/wsh` is now `*`, so a consumer that pins another wsh for its own reasons no longer gets a second, nested copy. The versions the features need (0.45 for links, 0.50 for services) are reported at use as a `WSH_UNAVAILABLE` error.

  Nothing is removed for one release. What an existing importer must change: code that imports the names above from `@johnhenry/browsermesh-transport` keeps working wherever the `node` export condition applies (Node, a bundler built for Node) through a shim; anywhere else (a bundler or import map for the browser, a vendored copy of `src/`) import them from `@johnhenry/browsermesh-transport/wsh` now. The shim is removed in the next minor, so move those imports before then. Importing `@johnhenry/browsermesh-transport/wsh-in-process` from a browser build never worked in practice and is now refused at resolution.

  `@johnhenry/browsermesh-apps` imports `WshPeerLinks` from the new subpath, falling back to the package root for a transport older than 0.11.

## 0.21.1

### Patch Changes

- 06068e5: `PeerRegistry.grantCapabilities` refuses a malformed `objects:` or `mcp:` scope, and `isGrantableScope(scope)` is exported (#334).

  These two namespaces have a written grammar in wsh's capability notation (`objects:ROOT[:OP]`, `mcp:TOOL`), and wsh refuses a list that holds an entry it does not understand. The registry used to take any string, and because `matchScope` reads a missing or empty segment as `*`, a grant of `objects:` covered every root and `mcp:` every tool. Now `objects:` and `mcp:` entries must name a root or a tool, `objects:` takes at most an operation (`get`, `call`, `set`, `on`, or the registry's own `*`), `mcp:` at most `call` or `list`, and a call with an entry that does not follow this throws a `TypeError` and grants nothing (the whole call, not the entries before it). Scopes in every other namespace are unchanged, including `objects:ROOT:*`, `objects:*:get`, `mcp:*` and `protocol:*:open`. A `GrantLog` replay skips a scope the registry would refuse instead of stopping.

  A caller that granted a malformed `objects:` or `mcp:` entry (which covered more than it said, or nothing) now gets a `TypeError` where it used to get a silent grant. `docs/capability-notation.md` lists where wsh's notation and the registry differ and which side was changed.

## 0.21.0

### Minor Changes

- 05b5b81: End-to-end sealing of routed messages.

  A routed message is sealed to the destination pod when its current key statement is known (ephemeral-static X25519, HKDF-SHA-256, AES-256-GCM; the originator, recipient and message id are the associated data). The signed envelope keeps `kind: 'mesh-routed/v1'` and carries the sealed box in `payload.sealed` with `message: null`, so forwarding hops still verify the originator's signature and the replay rules are unchanged, but they hold no key for the content. The message event carries `sealed: true | false` next to `authenticated`.

  Key statements (a pod's X25519 key signed by its identity key, expiring, rotated every hour, refused for a retired identity) are exchanged on the direct link when a peer is added (`mesh-routing-keys`) and fetched through the route on demand: `api.ensureKey(podId)`, `api.keyStatement()`, `api.learnKeyStatement(statement)`, `api.getKeyStatement(podId)`. Options: `sealing: false` turns it off; `sealingOptions` (`lifetimeMs`, `rotationMs`, `maxBytes`, `revocations`, `now`, `keyWaitMs`, `negativeCacheMs`, `maxQueuedPerDestination`, `schedule`); `requireSealed` on the service or on one `api.route(podId, message, { requireSealed: true })`: a message that cannot be sealed with a statement already cached is refused with `SealedUnavailableError` (code `E_SEALED_UNAVAILABLE`) and a `mesh-routing:drop` event (`sealed-unavailable`), and a node with `requireSealed` refuses readable envelopes addressed to it (`unsealed`). New drop reasons: `sealed-too-large`, `sealed-unsupported`, `bad-seal`.

  Behaviour changes to know about. With sealing on (the default for a node that can sign and has X25519), a message to a pod whose statement is not cached is no longer sent at once: `route()` still returns its result immediately, but the message waits (at most 16 queued per destination; the overflow is dropped as `sealed-unavailable`, never sent readable) while the statement is fetched, for at most `keyWaitMs` (default 2 s), and is then sent sealed. A destination that sends no statement in time is treated as not sealing for `negativeCacheMs` (default 60 s); the message goes out as the signed readable envelope, the service emits `mesh-routing:sealed-fallback`, and delivery reports `sealed: false`. A service therefore sends one extra signed control message per new destination, and a pod on an earlier release costs the first message to it up to `keyWaitMs`. A hop that suppresses key statements can force the readable fallback; `requireSealed` refuses instead. A pod on an earlier release publishes no statement and is sent the readable envelope it understands; an earlier hop forwards a sealed envelope unchanged. Hops still see the originator, recipient, size and timing, and can still drop, delay and reorder.

## 0.20.0

### Minor Changes

- 5d3c606: An inbound wire `ESCROW_CREATE` can become a real, funded contract through a ledger hook the deployment supplies (#239).

  `PaymentRouter.attachEscrowLedger(mutateLedger, opts)` takes the `mutateLedger(op, amount, podId, memo)` hook shape `EscrowManager` already accepts; `createMultiPartyLedgerHook(ledger)` is the documented default shape for a per-pod `MultiPartyCreditLedger`. The authenticated sender is the payer: a `payerPodId` in the message that differs is refused (`payer-mismatch`) before any ledger call; a hook that reports an insufficient balance leaves nothing held; the message's `escrowId` is an idempotency key so a repeat is not charged twice; amount, memo, timeout, id and payee are bounded; every refusal is reported to an `onAudit` callback without an amount. Failures are an `EscrowWireError` with a named `code` (`router.handleEscrowCreate()`), and the wire subscriber resolves `{ ok, code }`. `EscrowManager` no longer requires a `creditLedger` when it is given a `mutateLedger`.

  Nothing is on by default: with no hook attached, an inbound `ESCROW_CREATE` is only mirrored in the `SimpleEscrowBook` exactly as before, and `attachEscrowManager({ delegateWire })` is unchanged. No new wire fields are required; a peer that sends none of the new ones (`escrowId` is the one the hook path needs, and the book's own records already carry it) is unaffected.

## 0.19.0

### Minor Changes

- 53fb3d8: Streams and per-root authorisation for layered protocols over a protocol channel (#272).

  `createStreamLayer(channel)` (`protocol-stream.mjs`, also `@johnhenry/browsermesh-apps/protocol-stream`) carries a body larger than one message over any protocol channel: a per-stream byte window the receiver grants and the reader returns as it consumes (so a reader that stops reading stops the writer, and the receiver never holds more than a window), `maxStreams` and `maxStreamBytes` limits, cancel from either end or an `AbortSignal`, `authorize(meta, { peer })` before the open is answered, and `sendBody`, `reader.bytes()`, async iteration and web-stream adapters. It is built on `request` and `notify` only, so it runs over the mesh channel and over any hand-written duplex; a stalled stream holds neither the link nor other requests.

  `createRootAuthorizer({ protocol, check })` (`protocol-roots.mjs`, also `@johnhenry/browsermesh-apps/protocol-roots`) and `service.api.rootAuthorizer(protocol)` on the protocol service: the scope `<protocol>:<root>:<action>` through `PeerRegistry.checkAccess` for the channel's verified peer, default deny, with `guard()`, `can()`, `assert()`, `allowed()` and `scopes()` helpers.

  Additive. Nothing is attached or enabled by default. A peer that does not run the stream layer answers `stream.open` with -32601 and receives nothing else; an older peer never sees a new frame.

## 0.18.0

### Minor Changes

- d258e4b: Access control: one scope matcher, grants that end are announced, and what holds a grant open follows it.

  - `matchScope()` (primitives) compares scopes segment by segment for any number of segments; it used to ignore every segment past the third. Scopes of three segments or fewer match exactly as before. `PeerRegistry`'s built-in ACL (used when none is injected) now uses it instead of a matcher that looked at two segments, so `mesh-relay:<service>:connect`, `server-share:<name>:request`, `protocol:<name>:open`, `mesh:link:connect` and the like match their grants (before, only `*:*` did) and `mesh-relay:*:connect` no longer matches every action.
  - A grant with `expiresAt` is announced like a revocation: `registry.onAccessChange` gets `{ pubKey, kind: 'expired' }`, from one timer per registry for the nearest expiry. New options `clock` and method `dispose()`.
  - Long-lived holders follow access changes instead of waiting for their next use: `createMeshWebSocketService` sessions (new `accessResource`, `accessAction`, `recheckOnAccessChange`; closed with 4403 `access revoked`), open protocol channels, swarm members admitted through the join gate, wsh links under the default authorizer (new `watchWshAccess()`), and torrent serving after a rate-limit wait.
  - `createProxyHandler()` checks the caller (`checkAccess`, `resource`, `public`).

  Breaking defaults: `createProxyHandler()` throws at construction unless given `checkAccess` or `public: true` (and answers 403 to a caller `checkAccess` does not allow); `createMeshWebSocketService` now asks `onConnection` again when that peer's access changes (set `recheckOnAccessChange: false` to keep the old behaviour); a protocol channel is closed at the moment of revocation rather than on its next use. A registry with no injected ACL that relied on three-segment scopes matching only `*:*` now matches the scopes it was granted. No wire change: pods on older versions are unaffected.

- 9aadc63: apps: `channelAdvertisement()`, `readChannelAdvertisement()`, `advertisedProtocolSupport()` and `peerSupportsFromAdvertisements()` (`@johnhenry/browsermesh-apps/channel-advertisement`) let a peer say, and another learn without a handshake, that it runs the message channel and which layered protocols and versions it serves; a peer that advertises nothing is still tried. netway: `new VirtualNetwork({ maxBufferedBytes })` caps the bytes held unread or unsent by the sockets its `connect()` handed out and refuses new connections with `BufferLimitError` (`ENOBUFS`) while it is reached; off by default.
- d029c83: Hosted pods have owners. Within one `pod-host` resource, `send`, `exec`, `snapshot`, `restore` and `drain` on an existing pod now need the requester to have spawned it through the service or to hold an explicit grant on the pod itself (`<resource>/<name>:<verb>`); the verb on the resource alone no longer reaches another requester's pod. `status` of another's pod stays redacted and no longer registers interest in its events. A pod the service did not spawn has no owner and needs such a grant. Callers that only use pods they spawned are unaffected; a deployment that relied on one identity driving another's pods must grant on the pod. `InMemoryPodHostDriver` now refuses (`ELANE`) a podspec for another lane than its own unless constructed with the test option `acceptAnyLane: true`.
- a4de170: Placement decisions can go through `planPlacement()`: `MeshOrchestrator#placePod()` (and `releasePlacement()`), the `constraints` argument of the `meshctl_spawn` tool, and new `decidePlacement()` / `resolveRequesterTrust()` exports. The requester's trust is read from the local trust graph; with no requester, no trust graph or no usable value the requester is untrusted and is placed only behind a language or hardware boundary that the host states. A podspec `budget` is refused unless a budget check is configured and accepts it, a per-requester pod quota is checked before placement, and each decision is audited. Pod hosts now also state their `boundary` in `describe()` (additive; hosts that do not state one count as having none). Callers that pass no constraints are unchanged.
- 5e3cb9b: Routed envelopes (`MeshRouter`, `createMeshRoutingService`) now carry the originator's signature: a pod message signature over the originator, the final recipient, a message id, the content and the signer's session counter. The final recipient verifies it (and refuses a copy it already accepted) and every forwarding hop verifies it and drops what does not verify, so a hop can no longer forge or change a routed message's content, origin or recipient. `path` and `ttl` stay hop-written and are treated as hints (`path` is bounded and decides nothing; `ttl` is clamped to the router's `maxTTL`). A hop forwards only for a peer it has a link with. New `mesh-routing:drop` event (`MeshRouter` event `drop`) with the reason; delivered messages gain `id` and `authenticated`. A hop can still drop, delay, reorder and read a routed message: confidentiality across hops is not provided (options in `docs/design/routed-confidentiality.md`).

  `MeshRouter` takes optional `signer`, `allowUnsigned`, `isLinked`, `replay`; `createMeshRoutingService` signs with the node's wallet identity and takes `allowUnsigned`. Without a signer a bare `MeshRouter` behaves as before. `handleRoutedMessage()` returns a promise for a signed envelope.

  Breaking default: a node that can sign now refuses unsigned routed envelopes from older peers; set `allowUnsigned: true` to keep accepting them (delivered with `authenticated: false`). Envelopes from this release keep the old top-level `from`, `to`, `ttl`, `message` and `path` and add `id` and `signed`, so an older hop still forwards them and an older recipient still reads them (it cannot verify the signature). The peer dependency on `@johnhenry/browsermesh-pod` is now `>=0.2.0` (the signing scheme).

- 450e5d4: Identifiers that match a response to a request, or name a connection, are now 128 random bits from `crypto.getRandomValues` (apps: mesh-rpc, the routing proxy, orchestrator, compute, agent swarm, verification, timestamp witnesses, swarm join and submit, escrow, chunk replication, torrent, mesh-websocket and mesh-relay connections; transport: stream ids; pod: hosted-pod request ids). There is no `Math.random` or clock-and-counter fallback any more: where the platform has no CSPRNG, creating the id throws an error that says so. The modules that patched `crypto.randomUUID` with a `Math.random` version when it was missing no longer do. Escrow contract and dispute ids are random as well.

  Every response is matched on the peer as well as the id: orchestrator, compute, agent swarm, verification, escrow, swarm join and submit, chunk fetch and "have" answers, timestamp witnesses (a peer that was not asked is not counted) and mesh-websocket sessions (an envelope for a connection id is taken only from the peer at the other end). mesh-rpc, the routing proxy, torrent pieces and manifests, files and terminal already did.

  No wire change: the id is an opaque string to the peer that echoes it. A peer on an older release answers with whatever id it was sent. Ids are no longer of the form `<podId>:<time>:<counter>`; anything that parsed them should not.

- 4e71bfa: `createMeshNode()` wires the node's identity into its WebRTC connections, so the identity binding proof runs by default: each side proves possession of its pod key over the DTLS fingerprints of the session descriptions it applied, and a signalling server that swaps the descriptions is detected and the connection closed. `requirePeerBinding` is true (nothing a peer sends is delivered before its proof verified). New options: `webrtcIdentityBinding` (default `true`; `false` turns it off), `webrtcAllowUnboundPeers` (default `false`; the named opt-out for interop with peers on transport older than 0.6.0) and `webrtcBindingTimeoutMs` (default 10000).

  A peer that sends no proof (transport older than 0.6.0) is closed after the binding timeout, with the reason `timeout`. The reason now reaches the application: the caller's `connectToPeer()` rejects with `... identity binding failed: timeout` as soon as the connection is closed (it used to wait out the open timeout and say only that the channel did not open), and `PeerNode` emits `peer:binding-failed` (`{ pubKey, transport, connectionId, reason }`) on both sides (new `PeerNode#reportBindingFailure`, new `onBindingFailure` option of `createWebRTCTransportFactory`). Transport: `WebRTCMeshManager#bindingPolicy` reports whether binding is enabled and how it is applied.

  Breaking default: connections between a node from this release and a peer on transport older than 0.6.0 no longer come up unless `webrtcAllowUnboundPeers: true` (or `webrtcIdentityBinding: false`). Peers on 0.6.0 or later already send and check the proof when given an identity, so two nodes from this release interoperate with no configuration. `@johnhenry/browsermesh-apps` now asks for `@johnhenry/browsermesh-transport` `>=0.6.0` as a peer. Verified on a real `RTCPeerConnection` in Chromium and Firefox (see `tests/browser/README.md`); no problem was found in how the DTLS fingerprints are read from real session descriptions.

### Patch Changes

- ffeae5f: A JSON message that arrives in window-sized pieces is now reassembled with a bound and parsed once: `readJsonMessage` (apps) and `FsServiceBackend` (netway) scan the bytes they already hold and parse when the document is balanced instead of after every piece, and refuse a message larger than `maxBytes` (default 16 MiB, `maxMessageBytes` option on `FsServiceBackend` and the cloud-storage backend) with an error reply and a closed connection. The wire format is unchanged, so an older peer is served as before.
- 50835f4: `DhtNode` takes an optional `now` clock (default `Date.now`) that its stored values expire against, so TTL expiry can be driven without waiting. `MeshRouter` announces a routed message that ran out of TTL as a `drop` event with reason `ttl-expired` (it was only logged before).

## 0.17.0

### Minor Changes

- 9eb5b87: `PaymentRouter.attachEscrowManager(manager, { delegateWire: true })` hands an inbound `ESCROW_CREATE` to the conditional `EscrowManager` (the sending pod is the payer and is debited through the manager's ledger) instead of only recording it in the router's wire book. Off by default: without the option nothing changes. The manager needs a per-pod ledger (`MultiPartyCreditLedger`, or a `mutateLedger` hook).
- b98cac2: Add `createMeshChannelService()` (`mesh-channel.mjs`, also exported as `@johnhenry/browsermesh-apps/mesh-channel`): a message-oriented duplex channel beside `mesh-rpc` with requests in both directions, notifications, per-request progress and cancel, native `Uint8Array` values, a negotiated maximum message size enforced before a message is assembled, byte-based credit flow control, bounded in-flight requests per peer, close semantics that reject pending requests, and the caller's verified identity handed to every handler. It is negotiated with a version handshake; a peer that does not run it is never sent more than one `hello` and `open()` rejects cleanly. `mesh-rpc` is unchanged apart from its request ids, which now carry a random component (same string shape, one extra colon-separated field).
- a4afff2: Add the pure placement logic for hosted pods: `planPlacement()` (lane, verb, health, isolation boundary, capability and admission-limit matching, requester quota, ranking), `HostHealth` (per-host circuit breaker), `PlacementLedger`, and `createHostPool()` (spawn, drain, drain-a-host with make-before-break re-placement, restart decisions) over any `PodHostDriver`. The restart policy and backoff curve the pod supervisor already used are now shared as `decideRestart()` / `restartDelayMs()` / `policyWantsRestart()`; the supervisor's behaviour is unchanged. All additive: nothing uses the new exports unless called.
- 56b364d: Add the protocol-channel seam (`protocol-channel.mjs`, also `@johnhenry/browsermesh-apps/protocol-channel`): a documented duplex interface for layered protocols (`send`, `onMessage`, `request` with cancel and progress, `notify`, `onRequest`, `onNotification`, `onClose`, `peer`, `maxMessageBytes`), opened by name with `openProtocol` / `serveProtocol` over a mesh-channel link. Opening is authorised per protocol through `PeerRegistry.checkAccess` with the scope `protocol:<name>:open` (default deny, registry wildcards), re-checked on every use; `listProtocols` discovers what a peer will let you open. `createProtocolHost` works over any mesh-channel link, including a bare in-memory duplex. Nothing is served or authorised unless configured.
- 171ba28: Relayed connections end with the permission that allowed them, and hold a bounded amount of memory.

  `@johnhenry/browsermesh-apps`:

  - `MeshRelayHost` closes a peer's open connections, in both directions and with a reason, when the registry announces an access change (new `PeerRegistry#onAccessChange()` / `notifyAccessChange()`, fired by `revokeCapabilities()`, `removePeer()` and `updatePermissions()`), on `recheck()`, and every `recheckIntervalMs` (default 30000, `0` disables). `hideService()` and `detach()` close the matching connections; a connect that completes after `detach()`, a hidden service or a revocation is not acknowledged and its socket is closed.
  - Byte credit per connection (`highWaterBytes` 262144, `lowWaterBytes` 65536), a cap on unconsumed bytes per connection (`maxBufferedBytesPerConnection` 1048576) and per peer (`maxBufferedBytesPerPeer` 4194304), `maxConnectionsPerPeer` 16 and `maxFrameBytes` 65536, all options of `MeshRelayHost` (and, for the first four, `createMeshRelayBackend()`); `createMeshNode({ relayHostOptions })` passes them on. `host.stats()` / `backend.stats()` report buffered and in-flight bytes. A close sent for any of these reasons carries a `reason`, shown to the client as `socket.closeReason`.
  - Wire additions, all optional fields or new frames an older peer ignores: `window` on `connect` and `ok`, `credit` frames (sent only to a peer that advertised a window), `reason` on `close`. An older peer is held to the byte caps and is never paused.
  - `createMeshNode()` option `relayHostOptions`.

  `@johnhenry/browsermesh-netway`:

  - `StreamSocket#close(reason)` records why a socket was closed: the reason is readable as `closeReason` on both endpoints (the first reason given is kept) and is carried by `SocketClosedError#reason` on writes that fail afterwards. `close()` without a reason behaves as before. (Byte-level backpressure for `StreamSocket` is described in its own changeset.)

- a1411f9: `ServerSharing` and `createProxyHandler()` build the upstream request target from parsed parts and keep it on the configured origin.

  - The target is the configured origin plus a path and query from the peer. The path must begin with a single `/` and may not contain a scheme, authority, backslash, whitespace, control character or fragment; the resolved origin must equal the configured one, otherwise the request is refused (400) and nothing is sent.
  - Peer requests to `ServerSharing` must pass `registry.checkAccess(peerKey, 'server-share:<name>', 'request')`, with `peerKey` the key of the session the message arrived on. New option `registry` (on `ServerSharing` and `createMeshRoutingService()`). Without a registry, peer requests are refused (403); a `handleRequest(request)` call with no second argument is an in-process call and is unchanged. Grant with `registry.grantCapabilities(peer, ['server-share:<name>:request'])`.
  - Methods, request headers, header count and size, request body size, response size and request time are bounded, with options (`allowedMethods`, `allowedRequestHeaders`, `maxRequestBodyBytes`, `maxResponseBytes`, `maxHeaderCount`, `maxHeaderBytes`, `requestTimeoutMs`) and defaults listed in the README. `Host`, hop-by-hop headers, `Cookie` and `Authorization` are not taken from a peer; `expose(port, name, { headers })` sets headers the sharer chooses to send. Share names may not contain `:` or `*`.
  - Redirects from the upstream are not followed; the 3xx response is returned as it is. A response larger than the bound is refused (502), never truncated.
  - A proxy response is accepted only from the peer the request was sent to.

  Behaviour change to note: a host that used `createMeshRoutingService({ fetchFn })` without a registry now refuses every peer request until it passes `registry` and grants the scope.

- e39a071: Pod hosts that can spawn pods but have no shell (the isolate and browser lanes) are now visible to placement scoring. `listComputeCandidates(constraints, { includeSpawnHosts: true })` and `selectComputeTarget({ includeSpawnHosts: true })` also return them, as `spawn` + `runtime:<lane>` descriptors that never carry `compute`; without the option nothing changes, so shell execution is still only ever routed to hosts with a shell. `pickAutoHost()` uses the option.
- a81ccac: Wire the sealed wsh peer link through the peer layer (#273).

  - `createMeshNode({ wsh: { relays, ... } })` opts a node in (off unless given). The node's own identity is the wsh identity, a peer may link to it only if the registry grants `mesh:link:connect` (override with `wsh.authorize`), and `node.connectToPeer(podId, { wsh: podId })` reaches a peer. The listening side's inbound link is adopted as a `PeerNode` session under the pod id derived from the key wsh authenticated, so `fromPubKey` is that key and mesh-rpc, mesh-sync, mesh-relay and every other service run over it unchanged. `wsh.require: true` makes wsh the only transport `connectToPeer()` uses; a failed wsh link is then a failed connect.
  - New exports: `createWshAuthorizer(registry)`, `createWshAdapterFactory(links)`, `attachWshLinks({ node, links, negotiator })`, `WSH_LINK_RESOURCE`, `WSH_LINK_ACTION`.
  - `PeerNode.connectToPeer()` rethrows a negotiation failure when its negotiator was told to require a transport (`MeshTransportNegotiator` `require`), instead of falling through to a session with no transport. Without `require` nothing changes.
  - `MeshTransportNegotiator` gains a `required` getter (the transport type it was told to require, or `null`); `createHardenedNegotiator()` forwards it.

### Patch Changes

- b07934f: The JSON request/response sockets (`CloudStorageBackend` / `CloudStorage`, and netway's `FsServiceBackend`) no longer assume one `read()` is one message. A socket with a receive window hands a write larger than the window to its reader in window-sized pieces, so these readers now reassemble a message across pieces before parsing it; objects and files over 256 KiB round-trip again.
- df78ee0: The pod host service returns a pod's `env` values and `run.input` only to the requester that spawned it. Other requesters allowed to `status` or `list` the pod still see its name, state, module, limits, labels and the env variable names, with the values and the input replaced by `"[redacted]"`; a pod the service did not spawn is redacted for everyone. Existing clients that spawn a pod and read it back are unaffected.
- 15d5f74: File headers, comments, log tags, READMEs and examples no longer carry the name of the private monorepo this code was extracted from. No behaviour change, with these naming additions: `BrowsermeshEmbed` is the primary export of `@johnhenry/browsermesh-embed` and `ClawserEmbed` stays as a deprecated alias; the debug switch is now the `browsermesh_debug` localStorage key and the `[browsermesh:silent-catch]` console prefix, and the old `clawser_debug` key still works as a deprecated alias.
- 4dbd20c: `TorrentManager` now reads a finished download with `file.stream()` (falling back to `file.arrayBuffer()`, and to the callback `file.getBuffer()` for a 1.x client) instead of calling `getBuffer()` unconditionally, which WebTorrent 2.x removed and which left `download()` hanging. A failed or timed-out download rejects and is removed from the client, and `onProgress` is attached before the transfer can start.

  Downloads are now bounded in memory: `download(magnet, { maxBytes })` rejects a file larger than `maxBytes` (default `TORRENT_DEFAULTS.maxDownloadBytes`, 256 MiB; pass `Infinity` to lift it). An application that downloads larger files through the real-WebTorrent path must pass `maxBytes`.

## 0.16.0

### Minor Changes

- 7d06d5f: Add per-request AbortSignal and timeout support, caller-bound cancellation, handler deadlines, concurrency limits and bounded binary body encoding that survives JSON transports. Resource authorization remains the service handler's responsibility; cancellation does not roll back side effects.
- e2b4758: Share browser-safe mesh address parsing through primitives and discovery, retaining case-sensitive IDs and query strings. Remove the Node-only mesh-fetch factory path. Add explicit HTTP body mode and Request input with bounded byte-preserving uploads, native multipart headers, cancellation and correct HEAD/bodyless responses, while retaining the default structured JSON-body convention. HTTP bodies are buffered, not streamed.

### Patch Changes

- 7d06d5f: Bind pending mesh RPC responses to the intended transport peer. A matching request ID from another peer can no longer complete the call. Reject calls after teardown and settle failed sends without leaving an unobserved pending promise.

## 0.15.0

### Minor Changes

- 6c85935: Multiple named data channels over one negotiated WebRTC connection (#115). `WebRTCPeerConnection#openChannel(name, { ordered, maxRetransmits, maxPacketLifeTime })`, `closeChannel(name)` and `channels` add independent SCTP streams (no new ICE/DTLS handshake); `send(data, { channel: name })` addresses them (no fallback to control for an unknown or closed name), the remote adopts them automatically, and `onMessage` callbacks receive the channel name as a second argument. `WebRTCTransportAdapter` forwards these, and `PeerNode.sendTo` / `broadcast` accept a named channel the session's transport has opened. Open named channels only to peers on a build that has this: older builds adopt an unrecognised label as their control channel.

## 0.14.0

### Minor Changes

- 7fd84d3: `PaymentRouter` can now see the conditional `EscrowManager` (#229). New `attachEscrowManager(manager)`, `getEscrowManager()`, `listEscrows(podId?)` and `getEscrowById(id)` give one normalized view over the router's wire-level `SimpleEscrowBook` and the manager's contracts, and `startEscrowSweeper()` also expires (and refunds) the manager's due contracts, reporting them to `onExpired`. `SimpleEscrowBook` gains `listAll()`. Inbound `ESCROW_CREATE` still only records a hold; nothing existing changes unless a manager is attached.

## 0.13.0

### Minor Changes

- e0cf939: - `registerMeshTools()` registers `iot_list`/`iot_send`/`iot_telemetry` only when you pass `{ iotBridge }` / `{ iotTelemetry }` as a fourth argument (the package ships no IoT implementation, so they were permanently "not initialized"). The default is now the 12 non-IoT tools; pass both options for the old count of 15. The bridge duck types are documented and checked up front.
  - One implementation per public name for ledgers and escrow. `CreditLedger` stays the single-owner ledger (`payments.mjs`) and `EscrowManager` the conditional escrow (`peer-escrow.mjs`), exactly what the package index exported already. The two unreachable namesakes are renamed and now exported under their own names: `peer-payments.mjs`'s multi-peer ledger is `MultiPartyCreditLedger`, and `payments.mjs`'s flat escrow record is `SimpleEscrowBook` (what `PaymentRouter.getEscrow()` returns). `EscrowManager` now accepts a `MultiPartyCreditLedger` as well as a `CreditLedger`, and rejects a ledger of neither shape unless `mutateLedger` is given. README table added.
  - `TimestampAuthority` takes an optional `now` clock, which makes the outlier-rejection tests deterministic (the 'split clocks with some rejected' test only passed when two `Date.now()` reads returned the same millisecond).
  - The raw `PeerNode.onIncomingData()` subscribers were audited: all already parse JSON text through `decodeWireData`. A test now fails if one is added without it, and mesh-sync and the relay host/backend are exercised over a string-only wire and a real WebRTC data channel.
- e0cf939: `createTorrentService()` `api.download()` and `TorrentManager`:

  - `download(magnet, { onManifest })`: awaited between learning the manifest and requesting pieces, so a host with a storage quota can refuse before anything is fetched or stored. Return `false` (rejects with `code: 'manifest-rejected'`) or throw to abort.
  - `download(magnet, { onProgress })`: `{ received, total, bytes, size, cid, from }` per piece.
  - Pieces are now fetched in parallel: `download(magnet, { concurrency })` (1-32) with a service-level `downloadConcurrency`, **default 4** (was strictly one at a time). `concurrency: 1` keeps the old sequential order. Providers' `busy` answers are still retried with backoff.
  - A download that fails part-way removes the pieces it wrote itself (and that no held torrent lists), and emits `torrent:download-failed`.
  - Manifests remembered from other peers are bounded: `maxManifestChunks` (default 16384), `maxManifestSize`, 64-hex piece CIDs, and a piece count that matches the size are now required, and `maxRemoteManifests` (default 64) keeps the most recently used, dropping the providers recorded only for evicted ones. Manifests that do not meet this are ignored.
  - `TorrentManager` no longer imports `webtorrent` from `https://esm.sh` at runtime (it hung offline and failed under a strict CSP). Pass the library instead: `new TorrentManager({ webtorrent })` / `createTorrentService({ webtorrent })`, a constructor or a client; `window.WebTorrent`/`globalThis.WebTorrent` is still used when present. The new options are also forwarded by `createMeshNode({ torrentOptions })`.

## 0.12.0

### Minor Changes

- 987055a: Add runtime-class placement lanes (issue #185 WP4): `RUNTIME_CLASS`/`ISOLATION` constants, `ComputeRequest.constraints.isolation` and `moduleType: 'shell'`, matching `ResourceScorer` rules (hard isolation gate, shell-requires-microvm, `'any'`-lane preference bonus) and a `ResourceScorer.lane()` helper, `ResourceDescriptor.hostedBy`, an `execOnPod()` guard that denies shell execution against isolate-only runtimes (`exitCode: 126` + a `remote_exec_denied` audit record), and a `PLACEMENT_AUDIT` vocabulary with `MeshOrchestrator#recordPlacement()`. All additive with backward-compatible defaults (`moduleType` still accepts `'wasm'|'js'`, `constraints.isolation` defaults to `'any'`); no placement RPC is implemented yet -- that is issue #185's WP2/WP3.
- 3414bbb: Add the hosted-pods supervisor (issue #185 item 6, the last row of `docs/hosted-pods.md` §8a's control-surface table): `createPodSupervisor()` in the new `pod-supervisor.mjs`, composing three OTP ideas over the existing eight-verb control surface rather than reinventing them.

  - **Links** — `supervise(host, spec)` returns `{ref, spec, host, status}`; `link(parentRef, childRef)` (also implied by a podspec's `links.parent`) registers a parent/child relationship. `drain(ref, {cascade: true})` drains every descendant depth-first (grandchildren, then children, then `ref` itself) and emits `supervisor:cascade` with the full order. A child whose parent exits unexpectedly is drained too, never restarted, unless its own `restart.policy: 'always'` is paired with `links.detachOnParentExit: true`.
  - **Monitors** — `monitor(ref, fn)` fires `fn({ref, event})` for a watched pod's lifecycle/exit events, including a synthesized `{reason: 'host-lost', restartable: true}` exit when the pod's host disconnects (`PeerNode`'s `'peer:disconnect'` signal), for every pod that host was supervising.
  - **Supervisors** — `restart.policy` (`never`/`on-failure`/`always`) finally has an implementation: exponential backoff from `backoffMs` (default 1000ms, capped at 60s), bounded by `maxRestarts` (default 3) before giving up (`supervisor:gave-up`). **A restart is always a NEW `spawn` request the host may refuse** — it goes through `orchestrator.spawnPod()` (or an injected `PodHostClient`), never the driver directly; a refusal (`EACCES`/`EBUSY`) or a dead host (`host-lost`) re-places the pod via `pickHost` (default: the same `pickAutoHost()` selection `meshctl_spawn`/`meshctl spawn auto` already use).
  - Emits `supervisor:restart-scheduled`/`restarted`/`gave-up`/`cascade`/`host-lost` on its own `on()` bus, and through an optional `auditChain` via the new `SUPERVISOR_AUDIT` constants (reusing `PLACEMENT_AUDIT` for the spawn itself, recorded once by `orchestrator.spawnPod()`, never doubled).
  - `MeshOrchestrator#getSupervisor()` lazily builds one supervisor per orchestrator; `drainPod(hostPodId)` now consults it (without creating one it didn't need) so draining a host cascades into every pod it supervises before the pre-existing mesh-peer drain logic runs.
  - Two new `BrowserTool`s, `MeshctlSuperviseTool` (`meshctl_supervise`) and `MeshctlSupervisedTool` (`meshctl_supervised`), plus matching `meshctl supervise`/`meshctl supervised` text-dispatcher subcommands — bringing `createMeshctlTools()`'s total to 15, up from 13.

  `packages/browsermesh-meshctl` projects the same supervisor onto the external CLI: `pods supervise <host|auto> ... [--restart ...] [--max-restarts n] [--backoff ms] [--parent name]`, `pods supervised`, and a dev-only `pods crash <host> <name>` (loopback-only, forces the in-memory driver to report a crash so a restart can be demoed without waiting on a real failure) — see that package's README for the full command grammar. `meshctl watch` now also streams this session's own `supervisor:*` events alongside the host's `pod-host:event`s.

  `examples/16-supervised-hosted-pods.mjs` runs the whole story end to end: supervise a pod with `restart: 'on-failure'`, crash it twice and watch two real restarts land with doubling backoff, link a child, then drain the parent with cascade and watch the child go with it.

- 3414bbb: Add `meshctl` LLM tools for the hosted-pods control surface (issue #185 §8a item 4): five new `BrowserTool`s in `src/orchestrator.mjs`, projecting `pod-host-service.mjs`'s eight-verb protocol into the same tool-calling shape `meshctl_pods`/`meshctl_exec`/etc. already use.

  - `MeshctlSpawnTool` (`meshctl_spawn`) — `{host, name, lane?, run, limits?, caps?, env?, budget?, restart?}`, validated via `validatePodSpec()` before ever touching a host. `host: 'auto'` (or omitted) auto-selects a host matching the requested lane: primarily via `listComputeCandidates()` (the same descriptors `meshctl_compute` reads), falling back to the new `MeshOrchestrator#listPodHosts()` for the `isolate`/`browser` lanes `listComputeCandidates()` cannot see (no `exec` there, so no `compute` capability — a documented, pre-existing limitation). "The orchestrator proposes, the host accepts": a refusal from the chosen (or named) host is reported as-is, never silently retried elsewhere.
  - `MeshctlSnapshotTool`/`MeshctlRestoreTool` (`meshctl_snapshot`/`meshctl_restore`) — `{host, name}`.
  - `MeshctlHostedPodsTool` (`meshctl_hosted_pods`) — `{host}`, a table-plus-JSON listing of what a host is tracking.
  - `MeshctlHostsTool` (`meshctl_hosts`) — lists known pod hosts (lane, verbs, runtime classes) via `MeshOrchestrator#listPodHosts()`, a new read-only method reading runtime-registry peers tagged with `metadata.podHost`.
  - Every `PodHostDriverError` code is mapped to a human-readable, lane-aware message (e.g. `ELANE` on `snapshot`/`restore` against an isolate host: "isolate pods cannot snapshot/restore; Durable Object hibernation is automatic, not a verb you drive") instead of surfacing the raw errno-shaped code.
  - `registerMeshctlBuiltins()`'s `meshctl` text dispatcher grows matching `spawn <host|auto> <name> --lane <lane> --kind <kind> --ref <ref> [--entry <entry>]`, `snapshot <host> <name>`, `restore <host> <name>`, `hosted <host>` and `hosts` subcommands, with the same usage-string-on-error convention as the existing ones.
  - `createMeshctlTools()`/`registerOrchestratorTools()`/`createOrchestratorToolRegistry()` (`mesh-orchestrator-tools.mjs`) now wire all 13 `Meshctl*Tool`s, up from 8.

  `examples/15-agent-spawns-hosted-pod.mjs` runs the whole story end to end: a deterministic test `llmFn` driving a real `createAgentRuntime()` loop that calls `meshctl_hosts`, `meshctl_spawn` (`host: 'auto'`), `meshctl_hosted_pods`, `meshctl_snapshot`, `meshctl_restore`, and the pre-existing `meshctl_drain` — composing the five new tools with the original eight.

- 3414bbb: Add an HTTP-shaped view of the pod host service (issue #185 control-surface item 3), two ways: `pod-host-routes.mjs` (`POD_HOST_ROUTES`/`matchPodHostRoute()`, `createPodHostRouter()`, `podHostFetch()`) projects the eight verbs onto `mesh://` routes, mounted host-side via `createPodHostMeshRpcHandler()` over the existing `createMeshRpcService({onRequest})` slot (no change needed to `mesh-fetch.mjs`/`mesh-rpc.mjs` — that hook was already composable); `pod-host-gateway.mjs` (`createPodHostGatewayHandler()`, `serveNodeGateway()`) fronts the same control surface with a Web-standard `Request -> Response` handler and a real `node:http` adapter, so pods can be driven from entirely outside the mesh under the gateway's own mesh identity, gated by an operator-supplied `auth()` callback (no default-open gateway). Both reuse `pod-host-service.mjs`'s exact `checkAccess()` gate and status-code mapping rather than re-implementing access control.
- 3414bbb: Add the pod host service (`src/pod-host-service.mjs`, issue #185's hosted-pods control surface): the gated, audited mesh service that speaks `@johnhenry/browsermesh-pod`'s pod host protocol, so one peer can spawn and drive pods hosted on another.

  - `createPodHostService({driver, resource, auditChain, hostLabel, shellBackend})` — a `MeshService` descriptor. Each of the eight verbs (`spawn`, `status`, `send`, `exec`, `snapshot`, `restore`, `drain`, `list`) is checked as `registry.checkAccess(pubKey, resource, verb)`; a denial answers `EACCES`, emits `pod-host:denied` and writes a `placement_denied` audit record. Payloads are validated and normalized before any driver sees them. Driver lifecycle/log/exit events are forwarded to the peers that addressed the pod. Its `api` exposes `describe()` and `runtimePeer()`.
  - `createPodHostClient({peerNode, timeoutMs})` — one method per verb plus `describe()` and `onEvent()`, correlated by `requestId`, timing out with `ETIMEDOUT`, rethrowing remote `{code, message}` failures as `PodHostDriverError` so `err.code === 'EACCES'` reads the same locally and remotely.
  - `MeshOrchestrator` gains `spawnPod()`, `snapshotPod()`, `restorePod()` and `listHostedPods()`, plus a `podHostClient` constructor option (lazily built from `peerNode` when omitted), writing the requester half of the `PLACEMENT_AUDIT` trail through the existing `recordPlacement()`.
  - `podHostRuntimePeer(description)` projects a host into the runtime-registry peer shape `runtimePeerToComputeDescriptor()` already reads.
  - `POD_HOST_DESCRIBE` is a separate, deliberately ungated envelope rather than a ninth verb: it returns only what a host publishes in its announce metadata, and a peer must be able to discover a host before it can ask to be granted anything on it.

  `@johnhenry/browsermesh-pod` becomes a (non-optional) peer dependency: the protocol half of this feature lives there so a Worker or a microVM guest can import it without the app runtime.

  Known limitation, documented in the README: `runtimePeerToComputeDescriptor()` only produces a descriptor for peers advertising `shell`/`exec`/`tools`, so an isolate-lane pod host — which has no `exec` by definition — is not scored as a compute target and must be reached through this service directly.

  Over a real transport (WebRTC or WebSocket data channel) the host's reply and its lifecycle events reach the client as JSON text, not objects (browsermesh#208). `createPodHostClient()` subscribes to the raw `PeerNode.onIncomingData()` bus, so it now parses those strings the same way `ctx.onIncomingData()` does for services; before, every response was dropped and every call timed out with `ETIMEDOUT` outside in-process tests. Covered by a real-WebRTC suite (`test/real-peer/pod-host.test.mjs`).

## 0.11.0

### Minor Changes

- 14485f6: Fixes browsermesh#208, browsermesh#198 and browsermesh#193.

  - **Inbound envelopes over a real wire (#208).** A real transport can only carry text and binary, so a `MeshService` envelope reaches `PeerNode` as a JSON string. `ctx.onIncomingData()` now parses a JSON object/array string before matching `type`, so every service (compute, verification, torrent, chunk replication, ...) receives the parsed envelope. `MeshSyncBinding`, `MeshRelayHost`, `MeshRelayBackend` and `BrowserMeshWebSocket` accept the same. A string that is not a JSON object/array, or is corrupt, is ignored rather than thrown on. `PeerNode.onIncomingData()` itself still hands subscribers exactly what the transport delivered. Use it with a `@johnhenry/browsermesh-transport` release that encodes objects in `send()` (the patch released alongside this one).
  - **Bulk lane (#198).** `PeerNode.sendTo(pubKey, data, { connectionId, channel })` and `ctx.sendTo(pubKey, type, payload, { channel })` take `channel: 'control' | 'bulk'`. It is passed to the transport as `send(data, { channel })` only when given, so the default is unchanged; a transport with no bulk lane ignores it, and any other value throws a `TypeError`. Chunk replication (`chunk-push`, `chunk-fetch-response`) and the torrent service's `chunk-response` now use the bulk lane; requests and acknowledgements stay on the control lane.
  - **`PeerNode.broadcast()` (#193).** `broadcast(data, { channel, exclude, concurrency })` sends to every connected peer (one send per peer, bounded parallelism, default 8), collects per-peer errors instead of throwing, resolves to `{ sent, failed }` and emits a `'broadcast'` event. New `createPeerNodeTransport(peerNode)` returns the `{ broadcastFn, subscribeFn }` pair that `PaymentRouter`, `ConsensusManager`, `MigrationEngine` and `GroupKeyManager` take in `wireTransport()`; the sender passed to handlers is the peer the session belongs to, never the envelope's own `from` field.

## 0.10.0

### Minor Changes

- dd418b0: `createTorrentService()` gains hooks a real app needs (#199):

  - `chunkStore` and `manifestStore`: inject durable stores (for example `IndexedDBChunkStore` from browsermesh-sync) so a seeder that reloads keeps serving. `TorrentManager` accepts the same two options, plus `chunkSize`, and restores `listTorrents()` from them. Stores you pass in are never cleared by `destroy()`. The defaults stay in-memory, as before.
  - `authorize(fromPubKey, { kind, magnetURI, infoHash, cid, chunkCid })`: gate who may fetch manifests and pieces. A refused request gets exactly the reply an unknown one gets, so peers cannot probe what exists. Omitted means open, as before.
  - Serve limits: `maxConcurrentServes` (default 16), `maxConcurrentServesPerPeer` (default 4), `maxBytesPerPeerPerSec` (default unlimited) and `maxAnnouncesPerPeerPerMinute` (default 30). Over a cap a requester is told `busy` and downloaders back off and retry. `0` means unlimited.
  - New events `torrent:request-denied` and `torrent:serve-busy`; `torrent:chunk-served` and `torrent:chunk-received` are unchanged.
  - `createMeshNode({ torrentOptions })` forwards all of the above.

  Behaviour changes to know about: a node now only serves pieces that a manifest it holds lists (pieces that happen to sit in a shared store are not reachable); a `manifest-request` for unknown content is answered with `manifest: null` instead of silence, and a requester that asked several peers waits for a real manifest or for every peer to decline; chunk responses are only accepted from the peer that was asked.

  `TorrentManager.seed()` and `createTorrentService().api.seed()` now accept a string (UTF-8 encoded), `Blob`, `ArrayBuffer` and any typed array, and throw a `TypeError` for anything else. Previously a string was silently seeded as zero bytes (#195). `TorrentManager.getManifest(magnetURI)` is new.

  `IPFSStore` no longer pretends to have an IPFS backend (#197): the CDN Helia hook, which could never activate, is removed. It is a mesh-local content-addressed store whose CIDs are SHA-256 hex digests, and is now also exported as `MeshLocalCidStore`. `enabled` is still accepted but has no effect, and `available` is always `false`.

## 0.9.0

### Minor Changes

- BREAKING: the last two verify callbacks now use the canonical `(identity, signature, data)` order, the same as `PodIdentity.verify` and `crypto.subtle.verify`.

  - `TimestampProof.verify(verifyFn)` calls `verifyFn(signerPodId, signature, data)` (was `(signature, data, signerPodId)`), and `TimestampAuthority`'s `identity.verify` duck-type takes `(signerPodId, signature, data)`. A 64-byte signature in the first position throws a `TypeError`.
  - `Attestation.verify(verifyFn)` calls `verifyFn(podId, signature, resultHash)` (was `(podId, resultHash, signature)`).
  - Caller-supplied verify callbacks (`PaymentChannel` `verifyFn`, chat service `verifyFn`, `GrantLog` and key-distribution `wallet.verify`) are now probed once with a known-good Ed25519 vector. A callback that rejects the new order but accepts `(publicKey, data, signature)` makes the call that used it throw a `TypeError` naming the new order, instead of silently returning `false`. Skipped when `NODE_ENV` is `production`; the callback sees one extra call with `Uint8Array` arguments.
  - The peer range on `@johnhenry/browsermesh-primitives` is now `>=0.2.0 <1.0.0`.

## 0.8.0

### Minor Changes

- BREAKING: follow core's `verify(publicKey, signature, data)` order. `GrantLog` and key distribution now call `wallet.verify(pubKeyBytes, sig, data)`, so a custom duck-typed wallet must use that order. The injected `verifyFn` callbacks of `PaymentChannel` and the chat service change from `(pubKey, data, sig)` to `(pubKey, sig, data)`. The optional peer range on `@johnhenry/browsermesh-core` is raised to `>=0.5.0`.

## 0.7.1

### Patch Changes

- Fixes browsermesh#183.

  **`import '@johnhenry/browsermesh-apps'` broke in a browser bundle.** Seven
  files (`mesh-fetch.mjs`, `mesh-websocket.mjs`, `serverless-fetch.mjs`,
  `cloud-storage-backend.mjs`, `mesh-swarm.mjs`, `mesh-dht.mjs`,
  `mesh-relay-backend.mjs`) each had a top-level
  `import { createRequire } from 'node:module'`, left over from the 0.7.0
  fix that made their optional-peer resolution lazy: the actual `require()`
  _call_ was already deferred inside the function that needs it, but
  `createRequire` itself was still imported statically. A static import of
  `node:module` fails immediately when a browser (or a bundler without a
  Node-builtin shim) tries to resolve it -- before any function runs -- and
  all seven files are re-exported from the package root (`src/index.mjs`),
  so simply importing `@johnhenry/browsermesh-apps` broke in a browser, even
  for code paths that never touch the optional peer at all.

  Fixed by replacing the static import with a new internal helper,
  `createLazyRequire(url)` (`src/internal/lazy-node-require.mjs`), which
  obtains `require()` from `process.getBuiltinModule('module')` -- called
  only from inside the function that needs it, never at module load time.
  Nothing Node-only executes merely from importing any of the seven files
  now. `package.json`'s `exports["."]` also gained an explicit `"browser"`
  condition (pointing at the same, now browser-safe, entry) to make this
  guarantee explicit for bundlers. Zero API changes: every affected
  function/class keeps its exact existing signature, return value, and
  throw semantics.

  **`engines.node` republished at its real floor.** `engines.node` was
  bumped from `>=24.0.0` to `>=26.0.0` in a previous commit but never
  actually published -- the currently-published `browsermesh-apps@0.7.0`
  tarball still declares `>=24.0.0`, while sibling
  `@johnhenry/browsermesh-primitives`/`@johnhenry/browsermesh-pod` are
  already published requiring `>=26.0.0`. Since this package peer-depends
  on `browsermesh-primitives`, its published `engines.node` was already
  inaccurate for anyone actually able to install it. This release publishes
  the already-correct `>=26.0.0` value that's been sitting in the tree.

  **Root `AGENTS.md`/`CLAUDE.md` now documents the narrow, intentional
  circular relationship** between `browsermesh-core` and `browsermesh-apps`
  (each lazily `import()`s one specific thing from the other; both
  directions are optional peerDependencies) -- previously only
  `browsermesh-core/README.md` explained it, and the root docs' strict
  top-down package tables gave no hint it existed.

## 0.7.0

### Minor Changes

- 18e4f84: `@johnhenry/browsermesh-discovery` and `@johnhenry/browsermesh-netway` are now genuinely optional peerDependencies -- the final 2 of the 5 originally-eager "optional" peers (after `browsermesh-transport`/`browsermesh-kernel` and `browsermesh-core` in the two prior releases) now actually behave that way. A consumer of `.` with zero optional peers installed can import the full barrel and use any feature that doesn't touch discovery/netway without error.

  **Technique**: unlike the transport/kernel/core fixes (which used a dynamic `await import()`, requiring 3 factory functions to become `async`), every file here uses `createRequire(import.meta.url)` -- Node's stable synchronous `require()` of an ES module (Node >=22.12/23, well within this package's own `engines.node: >=24` floor). `require()` resolves the module lazily (only when the code path that needs it actually runs, not at this module's own load time) while staying fully synchronous, so it works in places a dynamic import structurally cannot: inside a constructor, or where a synchronous validation-throw is directly tested via `assert.throws(...)`.

  **Fixed, zero breaking changes** (all five keep their exact existing signature and throw/return semantics):

  - `mesh-fetch.mjs` -- `createBrowserMeshFetch()` and the `browserMeshFetch(url, init)` it returns both stay fully synchronous, including the synchronous `TypeError` for a malformed URL (matching real `fetch()`).
  - `mesh-websocket.mjs` -- `parseMeshRequest()` is resolved lazily _inside_ `BrowserMeshWebSocket`'s constructor (the file that motivated trying `require()` at all: a constructor can never be `async`, so a dynamic `import()` was a structural dead end here regardless of any breaking-change tolerance).
  - `mesh-dht.mjs` -- `createMeshDht()` stays synchronous; its directly-tested validation throws are unaffected.
  - `mesh-swarm.mjs` -- `SwimMembership`/`SwarmCoordinator`/the `SWARM_*` constants are resolved lazily inside `attach()`, preserving `mesh-service.mjs`'s synchronous `attachService()` convention.
  - `serverless-fetch.mjs` -- `createServerlessFetchRouter()` stays synchronous; its directly-tested validation throws are unaffected.

  **Fixed, BREAKING change** (the one case `require()` can't help with): a class's `extends` clause is evaluated at class-declaration time, and a `class X extends Y {}` statement written at module top level always runs at module-load time no matter how `Y` is obtained -- there is no way to defer that with a plain lazy import, sync or async. Fixed by moving the class declaration itself out of module-top-level scope into a function that resolves the base class via `require()` and builds+memoizes the class on first call:

  - `cloud-storage-backend.mjs` -- `CloudStorageBackend` is no longer exported as a class. Replace `new CloudStorageBackend(opts)` with `createCloudStorageBackend(opts)` (same `opts` shape, returns a real `CloudStorageBackend` instance with the identical instance API).
  - `mesh-relay-backend.mjs` -- same change: replace `new MeshRelayBackend(opts)` with `createMeshRelayBackend(opts)`.

    Every in-repo call site (5 test files for `CloudStorageBackend`, 3 test files + 2 runnable `examples/` scripts + the README for `MeshRelayBackend`, plus `cloud-storage.mjs`'s own internal use of `CloudStorageBackend`) has been updated. No `instanceof`/subclassing usage of either class existed anywhere in the repo (verified by grep before making this change).

  **Also fixed in this release**: `examples/07-full-mesh-pipeline.mjs` was missing an `await` on `createMeshKernel()` (made `async` in the prior 0.6.0 release) -- a real, previously-undetected gap, since `npm run examples` isn't part of either the default or `test:real-peer` suite. Running every example end-to-end as part of this release's own verification (not just the test suites) caught it; it's fixed here, and all 11 examples now run clean via `npm run examples`.

  **Still required, not optional** (unaffected by this release): `@johnhenry/browsermesh-primitives` and `@johnhenry/browsermesh-sync` remain genuine, non-optional dependencies of this package -- `cloud-storage-backend.mjs` imports `LWWMap`/`IndexedDBChunkStore`/`IndexedDBSyncStorage`/`TRANSFER_DEFAULTS` from them eagerly, deliberately, same as before.

  With this release, all 5 of `browsermesh-apps`'s originally-eager "optional" peerDependencies (`browsermesh-transport`, `browsermesh-kernel`, `browsermesh-core`, `browsermesh-discovery`, `browsermesh-netway`) are now genuinely optional -- verified end-to-end by temporarily removing all five from `node_modules` and confirming the full `.` barrel (333 exports) still imports cleanly, and that a peer-dependent function invoked without its peer installed fails with a clear, synchronous `MODULE_NOT_FOUND`, not a confusing crash.

- da863ba: `mesh-keepalive.mjs` now lazily imports `@johnhenry/browsermesh-core`'s `TransportHealthCheck` instead of importing it eagerly at module load time. This was the last remaining eager importer of `browsermesh-core` in this package -- `@johnhenry/browsermesh-core` is now genuinely optional for consumers of `.` who don't use any core-backed feature (keepalive, kernel, key-distribution, hardening), joining `@johnhenry/browsermesh-transport` and `@johnhenry/browsermesh-kernel` (made optional in the prior release) as the 3rd of the 5 originally-eager "optional" peerDependencies to actually behave that way.

  **Race safety**: `startCheckFor()` is called both from a synchronous `peer:connect` event handler and synchronously inside `attach()`'s initial peer-scan loop. A naive lazy import would open a real race -- two rapid calls for the same peer (e.g. a fast disconnect/reconnect) could both pass a bare `checks.has(pubKey)` de-dup check before the first call's import resolved, leaking an orphaned, un-stoppable `TransportHealthCheck` with a live ping timer. Fixed via a synchronous reservation/cancellation scheme: `checks.set(pubKey, {pending: true, cancelled: false})` happens _before_ the `await import()`, so the de-dup guard is correct the instant `startCheckFor()` returns, regardless of import speed. A concurrent `stopCheckFor()` arriving while pending cancels the reservation; the in-flight import becomes a no-op when it resolves.

  **No public signature change**: `createMeshKeepaliveService()` and the service's `attach()` remain fully synchronous. `api.getStatus(pubKey)` reports `'healthy'` during the brief pending window (mirroring `TransportHealthCheck`'s own `#status = 'healthy'` construction-time default in `hardening.mjs`, not `null`) so callers observe identical behavior to before this change. `api.getCheck(pubKey)` returns `null` until the real instance is actually installed -- it never exposes the internal reservation shape.

  **Still deliberately left eager** (each file's own header comment has the full reasoning): the 5 `@johnhenry/browsermesh-discovery` importers (`mesh-fetch.mjs`, `mesh-websocket.mjs`, `mesh-dht.mjs`, `mesh-swarm.mjs`, `serverless-fetch.mjs` -- each has either a directly-tested synchronous validation-throw contract that an async factory would silently break, or a constructor/class-extends usage that can't be deferred via a function-scoped dynamic import) and the 2 `@johnhenry/browsermesh-netway` importers (`cloud-storage-backend.mjs`, `mesh-relay-backend.mjs` -- both `export class X extends Backend`, evaluated at module-load/class-declaration time). None of these had a safe fix available without accepting real breaking changes to a tested or structural contract.

## 0.6.0

### Minor Changes

- Made `@johnhenry/browsermesh-transport` and `@johnhenry/browsermesh-kernel`
  genuinely optional for this package's top-level `.` entrypoint --
  `peerDependenciesMeta` already declared both `optional: true`, but every
  consumer of `.` (which `export *`s from 70+ modules) was forced to have
  both installed anyway, since several modules imported them eagerly at
  module top-level. Verified via a full recursive audit of every eager
  top-level import of an "optional" peer across this package, cross-checked
  against actual usage (was the imported symbol used inside an already-async
  function with no other callers to update, or would deferring it require a
  breaking signature change or an unsafe restructure).

  **Fixed (lazy `import()`, no observable behavior change beyond BREAKING
  notes below):**

  - `mesh-bootstrap.mjs`: `createMeshNode()` (already async) now lazily
    imports all of `@johnhenry/browsermesh-core`, `-discovery`, and
    `-transport` internally, instead of eagerly at module top-level.
  - `webrtc-negotiator.mjs`: `WebRTCTransportAdapter` (from `-transport`) is
    now lazily imported at its two call sites (both already inside async
    functions). `DEFAULT_CONNECTION_ID` is now a local literal
    (`'default'`, matching the real value in `browsermesh-transport`)
    instead of an eager import -- it's used as a default-parameter value in
    several places, evaluated at call time from whatever's in scope, which
    a lazily-resolved binding can't safely guarantee is ready yet.
  - `key-distribution.mjs`: `@johnhenry/browsermesh-core`'s
    `generateEncryptionKeyPair`/`wrapKeyForMember`/`unwrapKeyForMember` are
    now lazily imported at their (already-async) call sites. No public
    signature change -- `createKeyDistributionService()`/`attach()` stay
    synchronous.
  - `kernel-mesh.mjs`: `Kernel` (from `-kernel`) is now lazily imported
    inside `createMeshKernel()`.

  **BREAKING:**

  - `kernel-mesh.mjs`'s `createMeshKernel()` is now `async` (was
    synchronous) -- its only in-repo callers
    (`test/real-peer/kernel-mesh.test.mjs`,
    `test/real-peer/full-pipeline.test.mjs`) are updated to `await` it.
  - `mesh-hardening.mjs`'s `createHardenedNegotiator()` is now `async` (was
    synchronous) -- `MetricsRegistry` (from `@johnhenry/browsermesh-core`)
    was constructed synchronously at factory-call time, not deferred into
    any already-async internal path, unlike `RetryWithBackoff`/
    `TransportFailover`. Its two in-repo callers (`mesh-bootstrap.mjs`,
    `test/mesh-keepalive.test.mjs`) are updated to `await` it.

  **Evaluated and deliberately left eager** (each documented in its own
  file's header comment with the specific reason): `mesh-fetch.mjs` and
  `serverless-fetch.mjs` (`-discovery`, `-discovery` respectively) both have
  synchronous, directly-tested validation-throw contracts
  (`assert.throws(() => fn(...))`) and return real values (not promises)
  to many synchronous callers in their own test files -- making either
  async would silently break that documented behavior, not a simple
  per-call dynamic import. `mesh-websocket.mjs` (`-discovery`) uses its
  import inside a class constructor, which can never be async.
  `mesh-swarm.mjs` (`-discovery`) constructs its `-discovery` classes
  synchronously inside `attach()`, whose synchronous-return contract is a
  hard, repo-wide `mesh-service.mjs` convention relied on throughout
  `mesh-bootstrap.mjs`. `mesh-keepalive.mjs` (`@johnhenry/browsermesh-core`)
  has a synchronous de-dup guard around starting a per-peer health check
  that a lazy import would race (two rapid calls for the same peer could
  both pass the guard before the first import resolves) -- closing that
  safely needs a reservation/cancellation state machine, real complexity in
  production failover-adjacent code not attempted here.
  `cloud-storage-backend.mjs`/`mesh-relay-backend.mjs` (`@johnhenry/browsermesh-netway`)
  both use `Backend` as a base class
  (`class X extends Backend`), evaluated at module load time -- deferring a
  class's own base class requires either an async factory constructing an
  anonymous subclass (breaking direct `new X(...)`/`instanceof`/further
  subclassing) or a dynamic-base-class pattern, a real restructure of each
  file's public shape.

  **Net result**: `@johnhenry/browsermesh-transport` and
  `@johnhenry/browsermesh-kernel` are now genuinely optional for `.`.
  `@johnhenry/browsermesh-core`, `@johnhenry/browsermesh-discovery`, and
  `@johnhenry/browsermesh-netway` remain effectively required for `.` (one,
  five, and two files respectively still import them eagerly, each for a
  real, documented reason) -- use this package's existing subpath exports
  (`./mesh-rpc`, `./mesh-fetch`, `./mesh-service`, `./peer-registry`) to
  avoid them entirely if you only need that layer.

  All 2211 unit tests and all 10 real-peer (real WebRTC/TCP) integration
  tests pass unchanged.

## 0.5.0

### Minor Changes

- 6ba7b98: Multiple independent connections per peer (issue #116). Previously `WebRTCMeshManager.connectToPeer()` hard-deduped by `remotePodId` alone, so a peer already connected to could never get a second, independently-negotiated `RTCPeerConnection` -- and `PeerNode`, `webrtc-negotiator.mjs`'s signaling correlation, and `mesh-hardening.mjs`'s per-peer retry/failover/metrics scoping all assumed the same one-connection-per-peer shape.

  All of that is now additive and opt-in via a `connectionId` (defaults to `'default'`, so every existing call site is unaffected):

  - `WebRTCMeshManager.connectToPeer(remotePodId, { connectionId })` opens (or returns) an independent `RTCPeerConnection`, with its own ICE/STUN/DTLS negotiation and its own reconnect backoff. New `getConnectionsFor()`; `getConnection()`, `hasConnection()`, `listConnections()`, `closePeer()`, `broadcast()`, `getAllConnectionStats()` all became connectionId-aware.
  - `webrtc-negotiator.mjs` and `signaling.mjs` thread `connectionId` through the offer/answer/ICE exchange so two concurrent negotiations with the same peer never cross-route an answer or candidate.
  - `PeerNode.connectToPeer()`/`adoptIncomingSession()` tag the session they create with `connectionId`; `sendTo()`/`hasActiveSession()` accept an optional `connectionId` to address a specific one instead of always falling back to "most recently created". New `PeerNode.sessionsFor(pubKey)`.
  - `mesh-hardening.mjs`'s `endpointsKey(endpoints, auth)` folds `auth.connectionId` into its key. Without this fix a second `connectToPeer()` call with a different `connectionId` silently reused the first call's cached `TransportFailover` and reconnected _that_ connection instead of ever negotiating its own -- a real bug on the hardened path, not just a missing feature.
  - `@johnhenry/browsermesh-core`'s `ConnectionPool.add(peerId, transport, { purpose })` / `acquire(peerId, { purpose, select })` gained a real selector, answering the issue's second open question ("no way to request 'the connection for purpose X'").

### Patch Changes

- Added subpath exports for the mesh-rpc/mesh-fetch cluster
  (`./mesh-rpc`, `./mesh-fetch`, `./mesh-service`, `./peer-registry`),
  so a consumer that only needs `createBrowserMeshFetch()` (or
  `attachService()`/`createMeshRpcService()`/`PeerRegistry`) doesn't have
  to import the package's top-level `.` entrypoint, which `export *`s
  from 70+ modules including `webrtc-negotiator.mjs` -- an eager,
  unconditional import of `@johnhenry/browsermesh-transport`, even though
  that peer dependency is declared `optional: true`. A consumer without
  `browsermesh-transport` installed (a real scenario: `@johnhenry/hostable`
  only needs the mesh-rpc layer, not WebRTC signaling) previously couldn't
  import anything from this package at all, contradicting its own declared
  optionality. Verified the new subpaths pull in nothing beyond
  `@johnhenry/browsermesh-discovery`/`@johnhenry/browsermesh-primitives`
  (both already required), confirmed by reading each of the four modules'
  own imports directly and by a real import test with
  `@johnhenry/browsermesh-transport` absent.

  `PeerRegistry` was already exported from the top-level `.` entrypoint
  (`export * from './peer-registry.mjs'`) -- this only adds a narrower,
  lower-cost way to reach it, not new public API surface.

  The top-level `.` entrypoint's own eager-import behavior is unchanged
  here -- auditing and lazy-loading every `optional: true`-marked peer
  across the full 70+-module barrel (`browsermesh-kernel`,
  `browsermesh-netway`, `andbox`, etc., not just `browsermesh-transport`)
  is real, separate, larger follow-up work, not undertaken in this patch.

## 0.4.2

### Patch Changes

- Fixed `EncryptedBlobStore`'s internal `FileClient` calls: `store()`/`retrieve()`/`delete()`/`verify()` all called `writeFile()`/`readFile()`/`deleteFile()` without the leading `pubKey` argument the real `FileClient` (`peer-files.mjs`) requires — silently shifting every other argument by one position (the target `path` was being passed as `pubKey`, and the real payload as `path`). Same root-cause pattern as 0.4.1's `EscrowManager` fix: the test suite's mock `FileClient` was shaped to match the buggy 2-arg calls instead of the real 3-arg API. Fixed the mock and added a real end-to-end test — two real peers, real `FileHost`/`FileClient`, real wire protocol, not mocks — storing, retrieving, verifying, and deleting an encrypted blob for real.

## 0.4.1

### Patch Changes

- Fixed `EscrowManager`'s internal `CreditLedger` calls: `create()` called a `charge()` method that doesn't exist on the real `CreditLedger` (`payments.mjs`); `release()`/`refund()`/`checkExpired()`'s auto-refund all called `credit()` with the arguments swapped (`credit(podId, amount, ...)` instead of the real `credit(amount, fromPodId, ...)`). Untested until now because the test suite's mock ledger was shaped to match the buggy calls instead of the real class — fixed the mock to match `CreditLedger`'s real API, and added a new suite exercising `EscrowManager` against the real class directly. Same root-cause pattern as the `escrow_create`/`escrow_release`/`torrent_seed` tool-call-site bugs fixed in `@johnhenry/browsermesh-core` 0.0.1 — this is the one call-site bug that fix didn't cover, inside `EscrowManager` itself rather than the tool wrapping it.

## 0.4.0

### Minor Changes

- **BrowserMesh Serverless**: static sites and serverless functions served across mesh peers, adapted from a local `actually-serverless` reference (a single-machine, multi-tab Service Worker proxy) into a real mesh-native equivalent.

  - `src/cloud-storage.mjs`: added `getObject(key) -> {data, contentType, metadata}` and `stat(key) -> {size, contentType, metadata, updatedAt, version}` — the backend's `get`/`head` ops already returned these fields; the public class was discarding everything but raw bytes.
  - `src/serverless-static.mjs` (new): `createStaticHandler({store, indexFile, spaFallback, public, checkAccess})` — static-site serving on a `CloudStorage` bucket: index.html/implicit-directory-index resolution, optional SPA fallback, extension-based content-type guessing, HEAD via `stat()` (no chunk bytes pulled over the mesh). "Public" sites skip the read-access gate entirely at this layer (no wildcard-peer grant primitive exists anywhere in this repo's ACL stack); gated sites take an injected `checkAccess`.
  - `src/serverless-router.mjs` + `src/serverless-fetch.mjs` (new): `createSiteRequestHandler()` chains static → functions → proxy over a dedicated `'mesh-serverless'` `mesh-rpc` envelope type; `createServerlessFetchRouter()` finally gives `@johnhenry/browsermesh-discovery`'s `MeshFetchRouter` its first real caller.
  - `src/serverless-wire.mjs` (new): base64-encodes binary response bodies for the `mesh-rpc` wire hop, matching `cloud-storage-backend.mjs`'s existing chunk-byte convention.
  - `src/serverless-executor-andbox.mjs` + `src/serverless-functions.mjs` (new): `createAndboxExecutor()`, the light/default function-execution backend on `@johnhenry/andbox`'s Worker-isolated JS runtime — one fresh sandbox per invocation, never pooled (concurrent inbound requests are real, and andbox's own Worker-realm sharing plus collateral-timeout hazard makes pooling unsafe). `createFunctionsHandler()` is the backend-agnostic route matcher adapting any `executor(job) -> Promise<result>` into the router.
  - `src/serverless-proxy.mjs` (new): `createProxyHandler({targetOrigin, spaFallback})` — plain `fetch()` reverse proxy to an external URL with SPA fallback, not built on `GatewayBackend` (a different, transport-layer concern).
  - `src/serverless-peer-select.mjs` + `src/serverless-sites.mjs` (new): `selectPeer()`, a pure peer-selection function extracted from `scheduler.mjs`'s own inlined policy switch; `SiteRegistry` tracks which connected, admin-designated peers can serve a given site (mirroring `CloudStorage`'s own `replicaPeers` precedent).

  `andbox` is imported lazily (inside the executor, not a top-level static import) since it's a genuinely separate, not-yet-published package, not a workspace sibling like this package's other optional peer dependencies.

## 0.3.0

### Minor Changes

- **Mesh-native CloudStorage**: a full S3-like, encrypted, replicated object store with no server, built entirely from mesh primitives.

  - `src/mesh-service.mjs` (new): the `MeshService` attach convention (`{name, attach(peerNode, ctx) -> {teardown, api}}`) every service below is built on, plus an observability event bus (`ctx.emit()`/`handle.on()`/`handle.onEvent()`) and async-rejection isolation on `ctx.onIncomingData()` (a throwing/rejecting handler can no longer crash the shared dispatch loop or produce an unhandled rejection).
  - `src/cloud-storage-backend.mjs` (new): local encrypted (AES-256-GCM) object storage — `put`/`get`/`delete`/`list`/`head` over content-addressed, chunked (256KB) ciphertext, backed by `@johnhenry/browsermesh-sync`'s new `IndexedDBChunkStore`.
  - `src/grant-log.mjs` (new): a signed, replicated append-log for multi-peer bucket authorization (`s3:<bucket>:{read,write,delete,list,admin}` scopes), replaying into each peer's own unmodified `PeerRegistry`.
  - `src/key-distribution.mjs` (new): per-recipient encrypted bucket-key delivery on grant, built on `@johnhenry/browsermesh-core`'s existing `wrapKeyForMember()`/`unwrapKeyForMember()` (X25519 ECDH + AES-GCM).
  - `src/manifest-sync.mjs` (new): ACL-gated cross-peer manifest CRDT sync — a remote write is verified against the live `GrantLog` state before it's ever merged, not after.
  - `src/chunk-replication.mjs` (new): real cross-peer chunk push/pull with a `{durability: 'local-only'|'replicated', replicatedTo}` contract — `put()` never blocks or throws on an offline replica.
  - `src/cloud-storage.mjs` (new): the ergonomic `CloudStorage` SDK class composing all of the above behind `put`/`get`/`delete`/`list` plus `grant`/`revoke`/`designateReplica`.
  - `packages/browsermesh-sync/src/storage-indexeddb-chunks.mjs` (new, `browsermesh-sync` package): `IndexedDBChunkStore`, a durable, drop-in-compatible counterpart to the existing in-memory `ChunkStore`.
  - Proven over real WebRTC in `test/real-peer/cloud-storage.test.mjs`, not just mocked transport.

- **`fetch()`/`WebSocket`-shaped mesh access**: familiar Web APIs for reaching mesh-addressable resources.

  - `src/mesh-rpc.mjs` (new): request/response mesh-RPC transport (`createMeshRpcService()`), correlation IDs + timeouts, a clean `501` for an unregistered handler rather than a silent drop.
  - `src/mesh-fetch.mjs` (new): `createBrowserMeshFetch(meshRpcApi)` — a `fetch(url, init)`-shaped function for `mesh://podId/path` addresses, matching real `fetch()`'s reject-on-network-failure/resolve-on-HTTP-error semantics.
  - `src/mesh-websocket.mjs` (new): `BrowserMeshWebSocket`, a persistent duplex channel over the mesh with the standard `WebSocket` instance surface (`readyState`/`onopen`/`onmessage`/`send()`/`close()`), plus `createMeshWebSocketService()` for the accepting side.

- **Mesh-native key-value store and observability**: a second, smaller `MeshService` to prove the pattern generalizes, plus real event visibility.

  - `src/mesh-kv.mjs` (new): `MeshKv`, a small CRDT-backed replicated key-value store — no chunking, no encryption, reusing `GrantLog`'s ACL-gate-before-merge pattern directly.
  - `src/observability-bridge.mjs` (new): gives the previously-dormant `visualizations.mjs` (`TopologySnapshot`/`TrustHeatmap`/`VisualizationExporter`) a real data source — grants, replication activity, and connection events now flow into it live via `ctx.emit()`.

- **Nine previously-unwired application-layer modules wired as real `MeshService`s**, and three more migrated off the dead `PeerSession`/`SessionManager` architecture (now deleted):

  - `src/mesh-timestamp.mjs`, `src/mesh-health.mjs`, `src/peer-routing.mjs` (`createMeshRoutingService`, real multi-hop forwarding), `src/peer-escrow.mjs` (`createEscrowService`), `src/mesh-verification.mjs`, `src/mesh-torrent.mjs`, `src/peer-ipfs.mjs` — all wired for the first time.
  - `src/peer-files.mjs`, `src/peer-chat.mjs`, `src/peer-terminal.mjs` — migrated from the unwired `PeerSession` class onto `MeshService`; `src/peer-session.mjs` deleted entirely once nothing referenced it.
  - `src/mesh-compute.mjs`, `src/mesh-agent-swarm.mjs` — wired with a required, caller-supplied executor (`executeFn`/`agentProxy.chat`) rather than any default remote-code-execution backend.
  - `src/mesh-swarm.mjs` (new): the real SWIM failure-detection algorithm, leader election, and task distribution — `swarm.mjs`'s `SWARM_JOIN`/`SWARM_LEAVE`/`SWARM_HEARTBEAT`/`SWARM_TASK_ASSIGN` constants get their first real use.
  - `src/mesh-hardening.mjs`, `src/mesh-dht.mjs`, `src/mesh-keepalive.mjs` — real transport retry/backoff/failover, DHT peer discovery, and ping/pong liveness detection, all opt-in via `createMeshNode()`.
  - `src/audit.mjs`'s `AuditChain` wired into `createMeshNode({enableAudit})` — real, verifiable signed session audit entries.

- **A minimal, bring-your-own-LLM agent tool-calling runtime**: no LLM SDK dependency added, ever.

  - `src/agent-runtime.mjs` (new): `createAgentRuntime({registry, llmFn})` — a real tool-selection/dispatch loop; `llmFn` is required and caller-supplied (matching `mesh-compute.mjs`'s `executeFn`/`mesh-agent-swarm.mjs`'s `agentProxy` precedent).
  - `src/compat.mjs`: added `BrowserToolRegistry`, referenced in JSDoc across three files for a long time but never actually defined until now.
  - `src/mesh-orchestrator.mjs` (new): `MeshOrchestrator` (pod deploy/drain/discovery across the mesh) wired as a real, `checkAccess()`-gated `MeshService`.
  - `src/mesh-orchestrator-tools.mjs` (new): registers the 8 real `Meshctl*Tool` classes into a `BrowserToolRegistry`, gating risky actions through the service's checked `api`, not the raw class.
  - `src/kernel.mjs`'s `caps.net` (`@johnhenry/browsermesh-kernel`) upgraded from a bare boolean to a real, capability-scoped `ScopedNetwork` view via the new `Kernel#networkFor()`, mirroring `caps.mesh`/`meshFor()`.

### Patch Changes

- Fixed an unhandled-promise-rejection gap in `ctx.onIncomingData()`: it only caught synchronous throws, but every real handler in this package is `async`, so a failing handler could crash the dispatch loop instead of being isolated and logged like every other error path already was.
- Fixed a real open-ack/`onIncomingConnection` ordering race in `BrowserMeshWebSocket`: the accepting side could send its ack before the application had a chance to attach message handlers to the new session, silently losing a fast peer's first message.
- Fixed `FederatedCompute`'s dispatch retry loop continuing to run after `mesh-compute.mjs`'s `teardown()` — added a real `FederatedCompute#destroy()` cancellation path.
- Corrected `peer-ipfs.mjs`'s `IPFSStore` doc claims: it constructs a Helia instance but never actually used it for any storage operation — now documented as mesh-local content-addressed storage, not real IPFS-network interop.

## 0.2.0

### Minor Changes

- Wired discovery -> WebRTC signaling -> identity-verified connection (Phase 2). No code in the repo previously instantiated `PeerNode` with real subsystems — only hand-rolled test mocks.

  - `src/signaling.mjs` (new): `MeshSignalingChannel`, a small relay for `{type: 'webrtc-offer'|'webrtc-answer'|'webrtc-ice', from, to, payload}` messages over an injectable transport (works with `BroadcastChannel` in a browser or an `EventEmitterTransport`-shaped bus in Node).
  - `src/webrtc-negotiator.mjs` (new): wires a real `WebRTCMeshManager` + a `MeshSignalingChannel` into the factory shape `MeshTransportNegotiator.registerAdapter('webrtc', factory)` expects, handling both the caller side (offer/answer/DataChannel-open) and the callee side (auto-answer inbound offers), plus bidirectional ICE relay over the signaling channel.
  - `src/mesh-bootstrap.mjs` (new): `createMeshNode(options) => Promise<PeerNode>`, the composition root — builds a real `IdentityWallet`, `PeerRegistry` wired to real `MeshPeerManager`/`TrustGraph`/`MeshACL`, a `DiscoveryManager`, and the WebRTC negotiator above, then boots a real `PeerNode`.

- Wired `MeshSyncEngine` into `PeerNode`'s dispatch bus (Phase 3).

  - `peer-node.mjs`: added `PeerNode.adoptIncomingSession()`, resolving the callee-side session gap Phase 2 left out of scope — callees that only ever answer an inbound offer previously had a real, open transport but no `PeerNode`-level session, so `sendTo()`/`onIncomingData()` didn't work for them.
  - `webrtc-negotiator.mjs`: `createWebRTCTransportFactory()` gains an optional `onIncomingConnection(remotePodId, adapter)` hook, fired once a callee-side auto-answered offer's DataChannel opens.
  - `mesh-bootstrap.mjs`: `createMeshNode()` gains an opt-in `{ enableSync: true }` option that builds a `MeshSyncEngine` (durable `IndexedDBSyncStorage` by default) and attaches it as `node.sync`.
  - `src/mesh-sync.mjs` (new): `MeshSyncBinding` wires a `MeshSyncEngine` to a `PeerNode`'s existing dispatch bus — outbound via `sendTo()`, inbound via `onIncomingData()`, routed by `envelope.type`. `syncDocWithPeer()` sends a document's full state to one peer; `watch()` auto-broadcasts local changes to one or more peers.

- Wired the `MESH` kernel capability to a scoped, `checkAccess`-gated `PeerNode` view (Phase 4). New `src/kernel-mesh.mjs` (`createMeshKernel()`) composes a real `@johnhenry/browsermesh-kernel` `Kernel` with a `PeerNode` as its duck-typed mesh provider, so a kernel tenant granted `KERNEL_CAP.MESH` gets a capability view whose every send/receive is gated by `PeerRegistry.checkAccess()`. `browsermesh-apps` gains a new optional peer dependency on `@johnhenry/browsermesh-kernel`.

- `PeerRegistry.grantCapabilities()`/`revokeCapabilities()` now issue/revoke real `CapabilityToken`s through a `CapabilityValidator` (Phase 5), tracked per peer/scope so revocation has a live target independent of the ACL template's own state. `checkAccess()` now additionally consults live token revocation status (after the existing ACL check passes), so a capability granted then revoked is denied on the very next check — not just once the ACL template happens to be re-read. Peers/scopes granted outside `grantCapabilities()` are governed by the ACL alone, exactly as before — fully additive, no breaking API change.

- `createMeshNode()` already accepted `options.iceServers` and passed it straight to `WebRTCMeshManager`, but bypassed `webrtc.mjs`'s own `mergeIceServers()` extension point (Phase 6). Caller-supplied servers now route through `mergeIceServers()`, so TURN servers are validated and merged alongside the defaults rather than reimplemented ad hoc. Default (no `iceServers` supplied) and explicit `iceServers: []` behave identically to before.

- Added `MeshRelayHost` (`src/mesh-relay-host.mjs`) and `MeshRelayBackend` (`src/mesh-relay-backend.mjs`) (Phase 8), letting one mesh peer share access to a service on its own `VirtualNetwork` with specific, authorized peers over the real WebRTC mesh. Follows `mesh-sync.mjs`'s composition pattern and mirrors `GatewayBackend`'s connect/data/close/multiplex shape, carried as JSON envelopes with base64-encoded byte payloads. Authorization reuses `PeerRegistry`'s existing `grantCapabilities()`/`revokeCapabilities()`/`checkAccess()` with zero API or schema changes. `MeshRelayBackend` extends `@johnhenry/browsermesh-netway`'s `Backend`, so `browsermesh-apps` gains a new optional peer dependency on `@johnhenry/browsermesh-netway`. `mesh-bootstrap.mjs`'s `createMeshNode()` gains an opt-in `{ enableRelayHost, relayHostNetwork, relayHostServices }` option, attaching the host as `node.relayHost`.

- `GradientAggregator.aggregateGPU(device)` dispatches a real WGSL compute shader (`src/gpu-kernel.mjs`, new) instead of the plain-JS `aggregate()` math, with a tested fallback to `aggregate()` when no device is supplied or the flattened gradient buffer exceeds the device's storage-buffer limit; `aggregate()` itself is unchanged. Also fixes a completeness bug: `TrainingOrchestrator.handleGradientPush()` marked jobs `'aggregated'` but never called `aggregate()` at all — the result is now actually computed (via `aggregateGPU()`) and retrievable via the new `getJobResult()`/`getJobStatus().result`. `handleGradientPush()` and `handleMessage()` are now async as a result; the only prior callers were tests.

- `src/index.mjs` did not re-export `mesh-sync.mjs` (`createMeshSync`/`MeshSyncBinding`), unlike every other composition-root file added this cycle (`mesh-bootstrap`, `kernel-mesh`, `mesh-relay-host`/`-backend`). Fixed, alongside a new cross-package integration test (`test/real-peer/full-pipeline.test.mjs`) proving `enableSync`, a kernel-gated mesh capability, and `enableRelayHost` all wired onto the same `PeerNode` at once compose without collision.

## 0.1.1

### Patch Changes

- Peer dependency ranges were all ">=0.0.0", which accepts any version including a future incompatible major. They are now bounded at both ends: at least the version actually required, and below 1.0.0.

  browsermesh-apps declared core, transport and discovery as required peers but never imports any of them at runtime; every reference is a JSDoc type import, and the objects themselves are injected by the caller (discovery and transportNegotiator are optional and guarded at every use; wallet is required but supplied by the consumer, who therefore already has core). Since npm 7 installs peer dependencies automatically, that made installing apps pull in three packages it only needs for types. They are marked optional in peerDependenciesMeta.

## 0.1.0

### Minor Changes

- TimestampProof.verify() is now async. It accepted a verifyFn, documented it, and never called it, so any structurally well-formed proof verified with the confidence the proof asserted about itself. It now checks the authority signature and every witness entry and reports which was checked. Callers must await it.

  TimestampAuthority.verify() verifies through the issuing pod key rather than re-signing with its own, so a proof from another authority can be verified at all rather than reported as tampered.

  AutoMigrator no longer reports a migration it did not perform. It honours the drainPod verdict, takes a resolveWorkload option to supply what should be deployed, and workload names only what actually landed.

  The PeerSession heartbeat timeout can now fire; it was cleared by every ping, so a dead peer was never detected.

## 0.0.1

### Patch Changes

- Port clawser #31's unsigned-payment security fix into `payments.mjs`

  Found during a 2026-08-30 clawser feature audit: clawser's own local copy
  of the payment channel logic (`web/clawser-mesh-payments.js`) had a fix
  for unsigned/forgeable `PaymentUpdate`s and a unilateral `close()`, but
  that file is dead code -- `clawser-pod.js` constructs `PaymentRouter`
  from this published package, not the local copy, so the live app was
  still exposed. Same discovery pattern as `7491e94` (escrow/torrent tool
  bugs): the local "fixed" copy was never actually wired in.

  `PaymentChannel` now accepts an injected `signFn`/`verifyFn` pair (same
  shape as `peer-chat.mjs`'s convention, and compatible with
  `MeshIdentityManager.sign(podId, data)`/`.verify(pubKey, data, sig)`
  from `@johnhenry/browsermesh-core`):

  - `pay()` signs the `PaymentUpdate` it produces when a `signFn` is
    configured.
  - `receive()` verifies an incoming update's signature and rejects
    unsigned/tampered/forged updates when a `verifyFn` is configured.
  - `close()` becomes a two-phase mutual close when signing is active: the
    initiator signs a `CloseClaim`, the counterparty verifies it via the
    new `handleCloseMessage()` and cross-checks it against its own local
    ledger state before co-signing a `CloseAck` (`finalizeClose()` on the
    initiator's side) -- rather than trusting whatever numbers the wire
    message claims. A mismatch or invalid signature raises a
    `PaymentDispute` (`onPaymentDispute()`/`listDisputes()` on both
    `PaymentChannel` and `PaymentRouter`) instead of silently accepting or
    silently closing.

  Fully backward compatible: without an injected `signFn`/`verifyFn`,
  `pay()`/`receive()`/`close()` behave exactly as before (signature stays
  `null`, close stays unilateral and synchronous) -- signing is opt-in via
  the `PaymentChannel`/`PaymentRouter.openChannel()` constructor options,
  not mandatory, since not every consumer of this published package has a
  signing identity available.

## 0.0.0

Extracted from the private `clawser` monorepo and imported into the `@johnhenry` npm scope as part of the browsermesh monorepo consolidation. Previously published unscoped as `browsermesh-apps@0.1.0` (2026-07-17, manual publish, never CI-automated). Per family convention, the version restarts at 0.0.0 on scope import.
