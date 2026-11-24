# Changelog

## 0.5.0

### Minor Changes

- e70ce8b: The signalling clients honour a displaced connection.

  The signalling server now lets a verified pod hold several connections (default 2), delivers a message for it to the newest, and when it displaces one it sends `{ type: 'error', code: 'replaced', reconnect: false, message }` and closes it 4409 `replaced`. `WebSocketTransport` (pod) and `SignalingClient` (core) do not reconnect a displaced connection (that would displace another in turn). The transport sets `replaced` and calls the handlers of the new `onReplaced(fn)`; the client fires a `replaced` event and sets `replaced`; the application decides whether to connect again. A 4409 close with reason `replaced` is enough even if the error frame was lost. Other closes reconnect as before, and an open-mode or older server's 4409 `podId already registered` behaves exactly as it did.

  A pod that uses the same signalling server for its primary connection and for `signalingUrl` now keeps both connected and receives each message once: when the primary is a signalling connection, a `signal` frame delivered on the secondary connection (the server sends to the newest) is handled like one on the primary.

  Older servers send none of the new frames, so nothing changes against them.

## 0.4.0

### Minor Changes

- 76f59fa: The signalling clients speak the signalling server's authenticated registration (protocol 2).

  `SignalingClient` (core) and `WebSocketTransport` (pod, signalling dialect and the `signalingUrl` connection) take an `identity` (a `PodIdentity`, whose `podId` must be the pod id). Against a server in authenticated mode they answer its single-use challenge with a signature over the origin of the URL they were configured with, the pod id and the nonce, so the server can tie the pod id to the key that proves it. Against an open-mode or older server, which sends no challenge, they register as before after a bounded wait (`challengeWaitMs`, default 2000). `authentication: 'required'` never falls back; `'off'` never signs; `origin` overrides the signed origin for a server reached under another name.

  Without an identity, against a server that requires protocol 2, they fail with a named `SignalingAuthRequiredError` (and the transport stops retrying a refusal that cannot change). Other refusals are a `SignalingAuthError` carrying the server's own `code`. With no `identity` the existing behaviour is unchanged: `SignalingClient.connect()` still resolves on open (set `waitForRegistration: true` to have it reject on a refusal), and nothing new is sent to a server that does not offer the challenge.

  What the server says about a link is surfaced without being promoted: `registration` (`{ mode, verified }`), `SignalingClient.isSourceVerified(message)`, and on `WebSocketTransport` `serverVerifiedPeers` and a `relaySourceVerified` field on each delivered message (true only for a literal `true` set by the server). A server-verified pod is still a hint: it is not a broadcast recipient, which still needs the pod's own signed hello or ack. Open-mode and older servers read as unverified.

  `fetchIceServers({ url | signalingUrl, token })` (core) fetches the server's time-limited ICE servers, sending the token as a Bearer header only (never over plain `http` to a non-loopback host, never across a redirect).

  An older peer is unaffected: nothing is added to the open-mode register frame, and the relay dialect is unchanged.

## 0.3.0

### Minor Changes

- d029c83: Hosted pods have owners. Within one `pod-host` resource, `send`, `exec`, `snapshot`, `restore` and `drain` on an existing pod now need the requester to have spawned it through the service or to hold an explicit grant on the pod itself (`<resource>/<name>:<verb>`); the verb on the resource alone no longer reaches another requester's pod. `status` of another's pod stays redacted and no longer registers interest in its events. A pod the service did not spawn has no owner and needs such a grant. Callers that only use pods they spawned are unaffected; a deployment that relied on one identity driving another's pods must grant on the pod. `InMemoryPodHostDriver` now refuses (`ELANE`) a podspec for another lane than its own unless constructed with the test option `acceptAnyLane: true`.
- 3f9695f: Add `createIsolatedVmRuntime()` to `@johnhenry/browsermesh-pod/node-runtimes`: a `PodRuntime` that runs each hosted pod in its own V8 isolate (the optional `isolated-vm` dependency), declares the `language` boundary and may be advertised as the `isolate` lane. The isolate has no `require`, `process`, filesystem, network, timers or `WebAssembly`; a hosted module is loaded from the host's catalog only and may import nothing; only JSON strings and one log callback cross the boundary; the pod's `limits.memMib` and the request timeout are enforced by the isolate, and a breach disposes it and is reported through `onExit` (`oom` or `timeout`). `isolatedVmAvailability()` reports whether the addon loaded; `createIsolatedVmRuntime()` throws an error with code `ERR_ISOLATED_VM_UNAVAILABLE` and the reason when it did not. The runtime lane driver's exit event now also carries `cause`, the runtime's own reason. Nothing changes for installs without the addon or for callers of the existing runtimes.
- 0341de6: Discovery messages (`pod:hello`, `pod:hello-ack`, `pod:goodbye`) are now signed with the same scheme as other pod messages, and a peer list entry exists only for a key that proved itself. A goodbye is honoured only from the peer it names (for the session that said hello), or from the link that peer was on going down. What a relay or signalling server reports about peers (`peers`, `peer-joined`, `peer-left`, a relayed frame's `source`) is a hint of whom to greet: `WebSocketTransport` sends a hello to a hinted pod and any other broadcast only to pods whose signed hello or ack verified (new `verifiedPeers`, `confirmPeer()`, `forgetPeer()`). Peers carry `authenticated` and `sid`.

  Breaking default: over a relay or a custom adapter, an unsigned hello from a pod on 0.2.0 is now refused (counted as `unsigned`), so such a pod no longer joins the peer list or receives broadcasts. Set `allowUnsigned: true` on the newer pod to keep accepting them (listed with `authenticated: false`); same-origin transports keep accepting them by default. Signed hellos are accepted by 0.2.0 pods, which ignore the added fields.

  `@johnhenry/browsermesh-transport`: `WshPodTransport` now hands the pod the goodbye it synthesises when a link goes down under the link's identity (`{ peerId }`), so a pod on this release honours it. A pod on an older release is unaffected.

- 833c8b6: A pod's window message channel accepts a message only from a window and origin it was told about. New boot option `window: { sources, parent, origins, targetOrigin }`: `sources` are exact Window objects compared with `event.source`, `parent: true` adds the embedding parent (iframe) or opener (spawned window), `origins` are exact origins compared with `event.origin`, and a message must match every constraint given. A refused message is counted as `window-source` (`pod.dropped`, `message:dropped`). What an accepted window sends unsigned is delivered with `authenticated: false`, as before; a signature must still verify. The hello a child posts to its parent now goes to `targetOrigin` (default: the single configured origin, otherwise `'*'`) and only a configured parent window can answer it. `bootHostedPod()` passes `window: { parent: true }`.

  Breaking default: with no `window` option nothing is accepted from another window. Previously any window could post to the pod and was heard (unsigned messages accepted by default), and any window could answer the parent handshake. A page that relied on that sets `window`. Pods on older versions are unaffected on the wire: nothing new is sent.

### Patch Changes

- 450e5d4: Identifiers that match a response to a request, or name a connection, are now 128 random bits from `crypto.getRandomValues` (apps: mesh-rpc, the routing proxy, orchestrator, compute, agent swarm, verification, timestamp witnesses, swarm join and submit, escrow, chunk replication, torrent, mesh-websocket and mesh-relay connections; transport: stream ids; pod: hosted-pod request ids). There is no `Math.random` or clock-and-counter fallback any more: where the platform has no CSPRNG, creating the id throws an error that says so. The modules that patched `crypto.randomUUID` with a `Math.random` version when it was missing no longer do. Escrow contract and dispute ids are random as well.

  Every response is matched on the peer as well as the id: orchestrator, compute, agent swarm, verification, escrow, swarm join and submit, chunk fetch and "have" answers, timestamp witnesses (a peer that was not asked is not counted) and mesh-websocket sessions (an envelope for a connection id is taken only from the peer at the other end). mesh-rpc, the routing proxy, torrent pieces and manifests, files and terminal already did.

  No wire change: the id is an opaque string to the peer that echoes it. A peer on an older release answers with whatever id it was sent. Ids are no longer of the form `<podId>:<time>:<counter>`; anything that parsed them should not.

## 0.2.0

### Minor Changes

- 404e5be: A receiver never takes the sender of a `pod:message`, `pod:rpc-request` or `pod:rpc-response` from a field the sender or a relay wrote.

  - Pods sign outgoing messages by default (option `sign`): the message carries the sender's public key, a session id, a counter and an Ed25519 signature over a canonical encoding of sender, recipient, type, body and those fields. The receiver checks that `from` is the pod id of the key, verifies the signature, and refuses a repeat within a sliding window per sender session (clocks are not used). Only signed fields are delivered, with `authenticated: true`. New exports: `MessageSigner`, `verifyMessage`, `signedBytes`, `ReplayGuard`, `ReplayWindow`.
  - A transport that authenticates the peer itself can pass `(msg, { peerId })` to its handler; a message whose `from` differs is dropped.
  - Refused messages are counted in `pod.dropped` and announced as `message:dropped`.
  - **Breaking**: unsigned `pod:message` / `pod:rpc-response` from older peers are accepted only from transports that declare `trust === 'same-origin'` (`BroadcastChannelTransport`, `EventEmitterTransport`, `NullTransport`) and from window messages; they are refused from `WebSocketTransport` (`trust` `'untrusted'`) and from custom adapters that declare nothing. Set `allowUnsigned: true` to take them anyway, `false` to refuse them everywhere. An unsigned `pod:rpc-request` is no longer accepted by any pod.
  - **Breaking**: `send()` and `broadcast()` return a promise (signing is asynchronous) and need JSON-compatible payloads. Pass `sign: false` to keep unsigned sending; a `{ podId }` identity that cannot sign sends unsigned.
  - `WebSocketTransport` no longer turns the relay's `source` into the message's `from`; it is delivered as `relaySource`.
  - An older peer receiving a signed message sees extra fields (`pk`, `sid`, `seq`, `sig`) and otherwise the same message.

- 7e99fad: Add `createRuntimeLaneDriver()` and the `PodRuntime` adapter interface: a `PodHostDriver` over anything that can run a hosted module, with a host-side module catalog (a podspec never names a path), refused loader/limit environment variables (`NODE_*`, `LD_*`, `DYLD_*`, `UV_*`, `OPENSSL_*`), admission limits and the lifecycle events. A runtime claiming the isolate lane must declare a language or hardware boundary. New subpath `@johnhenry/browsermesh-pod/node-runtimes` with two runtimes that need no native dependency: `createWorkerThreadsRuntime()` (boundary `none`, not a security boundary) and `createPermissionProcessRuntime()` (boundary `process`, Node permission model). Additive: existing exports and behaviour are unchanged.

### Patch Changes

- 3f890a8: Pods now discover each other over `WebSocketTransport` whatever order the server's frames arrive in. The signalling server sends `peers` in a frame after `registered`, so the boot-time `hello` could go out before the pod knew anyone. `TransportDiscovery` now also sends a directed `hello` to each peer the transport newly learns of (`peers`, `peer-joined`), so a pod that was already running greets one that joins later. `WebSocketTransport` gains `onPeerJoined(handler)` for this, and a `protocol: 'signaling'` primary connection now reads `peers` / `peer-joined` / `peer-left` itself. A server that sends both frames at once, or `peers` first, behaves as before; an older peer receives an ordinary `hello` carrying an extra `to` field.
- 15d5f74: File headers, comments, log tags, READMEs and examples no longer carry the name of the private monorepo this code was extracted from. No behaviour change, with these naming additions: `BrowsermeshEmbed` is the primary export of `@johnhenry/browsermesh-embed` and `ClawserEmbed` stays as a deprecated alias; the debug switch is now the `browsermesh_debug` localStorage key and the `[browsermesh:silent-catch]` console prefix, and the old `clawser_debug` key still works as a deprecated alias.
- f61022c: README: point to `WshPodTransport` (in `@johnhenry/browsermesh-transport`), a sealed, key-authenticated `TransportAdapter` over wsh, and to what a mesh link does and does not protect.

## 0.1.1

### Patch Changes

- 4fb4230: `WebSocketTransport` now reads `Blob` frames (asynchronously, queued so frames keep their arrival order) instead of dropping them (#221).

## 0.1.0

### Minor Changes

- 3414bbb: Add the browser lane's in-page `PodHostDriver` (issue #185 item 7): spawning and controlling pages (iframes, `window.open()` windows, dedicated workers) that each boot a `Pod`, from inside a browser tab, with zero new dependencies.

  - `createInPageDriver({podUrl, spawnKind, channel, ...})` in `src/browser-host-driver.mjs` — `lane: 'browser'`, serving `spawn`/`status`/`send`/`drain`/`list` via `iframe`/`window.open`/`Worker` plus a shared `BroadcastChannel` for the `browser-host:ready` handshake, and `postMessage` for `send`. `exec`/`snapshot`/`restore` are `ENOTSUP`: a parent tab has no safe way to evaluate code in a child it spawned (same-origin or not), and no durable page-heap snapshot exists yet.
  - `bootHostedPod({globalThis, channel, name})` and `readPodName(g)` in `src/browser-host-child.mjs` — the ~20-line bootstrap any pod page or worker runs to boot a `Pod` and announce itself, reading its name from `window.name`/`self.name`/a `#name=…` URL-hash fallback so no new field was needed on `createHello()`.
  - `POD_LANE_VERBS[POD_LANE.BROWSER]` now includes `exec`: the browser lane decision is that `exec` means **"evaluate an expression in the page's JS context,"** not a shell command, and that is a real lane-level capability (the CDP and extension drivers in `spikes/browser-pod-host` / `spikes/browser-extension-host` implement it) even though this package's own in-page driver does not. `snapshot`/`restore` stay `ELANE` on the browser lane.

  See `docs/hosted-pods.md` §8b for the full three-driver picture (in-page, CDP, extension) and the trust caveat: a tab is not a privilege boundary against the page it hosts.

- 3414bbb: Issue #185 item 6 (the hosted-pods supervisor) ground-level support in `host-protocol.mjs`: `InMemoryPodHostDriver` now emits a structured `EXIT` event payload — `{ name, code?, reason?: 'drained'|'crashed'|'host-lost'|'evicted', restartable: boolean }` — on both `drain()` (`reason: 'drained'`, `restartable: false`) and a new test-only `crash(name, { code })` method (`reason: 'crashed'`, `restartable: true`), so a supervisor can tell an intentional stop from a failure without guessing. The podspec gains an optional `links` section — `{ parent?, hostedBy?, detachOnParentExit? }` (validated: non-empty strings, boolean) — so a spawn can declare its place in a parent/child supervision tree.
- 3414bbb: Add the pod host protocol (`src/host-protocol.mjs`, issue #185's hosted-pods control surface): the one lane-agnostic verb set — `spawn`, `status`, `send`, `exec`, `snapshot`, `restore`, `drain`, `list` — that every later surface (the `browsermesh-apps` pod-host service, `mesh://` routes, `meshctl` tools, an external CLI, a supervisor) projects.

  - `POD_HOST_VERB` / `POD_LANE` / `POD_LIFECYCLE` plus `POD_LIFECYCLE_TRANSITIONS` and `canTransition(from, to)` — the `docs/hosted-pods.md` §5.3 state machine as data, with a terminal `gone`.
  - `POD_LANE_VERBS` / `laneSupports(lane, verb)`: which lane can honour which verb is static, not a runtime surprise. `exec`/`snapshot`/`restore` are `ELANE` on the `isolate` and `browser` lanes today.
  - `validatePodSpec(spec)` and `validateVerbRequest(verb, payload)` returning `{ok, value}` / `{ok, errors}`. Only two defaults are applied (`lane` from `run.kind`, `restart.policy: 'never'`); unknown keys are an error at every level rather than silently ignored.
  - Wire shapes `createHostRequest` / `createHostResponse` / `createHostEvent` over `pod-host:request|response|event`, with `POD_HOST_ERROR` codes (`EACCES`, `ENOENT`, `EEXIST`, `EINVAL`, `ENOTSUP`, `ELANE`, `ETIMEDOUT`, `EBUSY`) and a `PodHostDriverError` carrying them.
  - The `PodHostDriver` interface as a JSDoc typedef (not a base class) plus `createUnsupportedDriverMethod(verb, lane)`, and `InMemoryPodHostDriver` — a complete reference driver with a configurable lane, a real lifecycle state machine, an injectable `exec` and `onEvent()` fan-out.

  This module lives in `browsermesh-pod`, not `browsermesh-apps`, deliberately: a Worker or a microVM guest can import the protocol without pulling in the app/agent runtime. `POD_LANE`'s strings are kept identical to `browsermesh-apps`' `RUNTIME_CLASS` rather than imported across the package boundary.

- 987055a: Add `WebSocketTransport` (issue #185, work package 1): a `TransportAdapter` that speaks the `browsermesh-servers` relay/signaling wire protocol, so a `Pod` can run outside a browser tab — in a plain Node process, a V8 isolate, or a microVM — and still join the mesh. Same injectable-constructor pattern as `BroadcastChannelTransport`'s `BCConstructor` (`opts.WebSocket`, default `globalThis.WebSocket`).

  - `send(msg)` relays point-to-point (`{type:'relay', target, envelope}`) when `msg.to` names a specific peer, and fans a `to`-less or `to:'*'` message (discovery's `hello`/`goodbye`) out point-to-point to every peer in `knownPeers`, since the relay server has no broadcast primitive.
  - `knownPeers` is seeded from relayed senders seen so far, plus — when `peersFromSignaling: true` and `signalingUrl` is set — a second connection to the signaling server that consumes `peers`/`peer-joined`/`peer-left`.
  - Exponential-backoff reconnect with re-registration (`reconnect: {baseMs, maxMs, maxAttempts}`); `ready` is false while disconnected; responds to `ping` with `pong`; `close()` clears all timers.
  - Exported from the package root and typed in `index.d.ts`.

  **Protocol gap found while implementing this against the real servers**: the design sketch in issue #185 describes the relay protocol using `to`/`from` fields, but `browsermesh-servers/relay/index.mjs` and `signaling/index.mjs` actually use `target`/`source` for `relay`/`signal` and their replies. `WebSocketTransport` speaks the servers' real field names (`target`/`source`) and remaps to the Pod message shape (`from`) only on the way in, so it interoperates with the servers as they exist on `main` today. The issue's protocol description should be corrected to match.

### Patch Changes

- 987055a: Documented how to run `Pod` outside the browser (exact runtime requirements, the `TransportAdapter`/`DiscoveryAdapter` contracts, a worked `EventEmitterTransport` + `NullDiscovery` Node example, and an explicit `node:vm`/`worker_threads`-are-not-a-security-boundary warning) in a new README section, and added a shared TransportAdapter conformance suite (`test/helpers/transport-conformance.mjs`) wired up for `BroadcastChannelTransport`, `EventEmitterTransport`, and `NullTransport`. Writing the suite surfaced one real bug it was built to catch: `BroadcastChannelTransport`'s `onmessage` callback did not guard against handler exceptions the way `EventEmitterTransport`'s dispatch loop and `Pod`'s own event emitter already do ("listener errors don't crash the pod") — a throwing handler would propagate as an uncaught exception instead of being isolated. Fixed with the same try/catch pattern already used elsewhere in this package. See `docs/hosted-pods.md` at the monorepo root (new) for the full hosted-pods design this work package is part of, tracking issue #185.

## 0.0.3

### Patch Changes

- Peer range on `@johnhenry/browsermesh-primitives` is now `>=0.2.0 <1.0.0`, so it no longer admits primitives 0.1.x, whose `PodIdentity.verify` takes `(publicKey, data, signature)`.

## 0.0.2

### Patch Changes

- Fix TypeScript declarations not being resolved (#179).

  `browsermesh-primitives` shipped `src/index.d.ts`, but its `exports` map
  used a bare string target with no `types` condition (and no top-level
  `types` field), so TypeScript ignored the sibling declaration file
  entirely and consumers hit `TS7016` on every import. `exports["."]` now
  has an explicit `types` condition (checked first) alongside `import`,
  and a top-level `types` field points at the same file.

  `browsermesh-pod` shipped no declarations at all, even though `Pod` and
  `BroadcastChannelTransport` are real public exports the tutorial docs
  use. It now ships `src/index.d.ts` covering its full public surface —
  `Pod`, `InjectedPod`, `detectPodKind`, `detectCapabilities`, the
  transport adapters (`BroadcastChannelTransport`, `EventEmitterTransport`,
  `NullTransport`), the discovery adapters (`TransportDiscovery`,
  `NullDiscovery`), the wire-protocol message constants and factories, and
  the `installPodRuntime` / `createRuntime` / `createClient` /
  `createServer` runtime entrypoints — wired into `package.json` the same
  way as primitives.

## 0.0.1

### Patch Changes

- Peer dependency ranges were all ">=0.0.0", which accepts any version including a future incompatible major. They are now bounded at both ends: at least the version actually required, and below 1.0.0.

  browsermesh-apps declared core, transport and discovery as required peers but never imports any of them at runtime; every reference is a JSDoc type import, and the objects themselves are injected by the caller (discovery and transportNegotiator are optional and guarded at every use; wallet is required but supplied by the consumer, who therefore already has core). Since npm 7 installs peer dependencies automatically, that made installing apps pull in three packages it only needs for types. They are marked optional in peerDependenciesMeta.

## 0.0.0

Imported into the `@johnhenry` npm scope as part of the browsermesh
monorepo consolidation. Previously published unscoped as
`browsermesh-pod@0.2.1`. Its `browsermesh-primitives` dependency now
resolves via the monorepo's npm workspace instead of the public registry.
Per family convention, the version restarts at 0.0.0 on scope import — see
the README's Provenance section.

## 0.2.1 (2026-07-17)

- Fixed: `Pod`'s internal event dispatcher was a true `#private` class field
  method (`#emit`), which JS private fields make unreachable from
  subclasses. `InjectedPod._emitPublic()` — meant to bridge into it — was
  consequently a no-op stub with no implementation, silently swallowing
  every `emit()` call. Renamed to a protected-by-convention `_emit()` so
  subclasses can dispatch through the same `on()`/`off()` listener
  registry; `InjectedPod.emit()` now calls it directly and the dead
  `_emitPublic()` stub is removed. `InjectedPod._onMessage()`'s
  `this.emit('pod:message', msg)` call (and any other subclass emit) now
  actually fires listeners registered via `pod.on(...)`.
- Added `test/injected-pod.test.mjs` — `InjectedPod` had no dedicated test
  file before this release.

## 0.2.0 (2026-03-16)

- Pluggable transport and discovery adapters
- Minimum Node.js bumped to 24

## 0.1.0 (2026-03-15)

- Initial release
- Pod base class with 6-phase boot sequence
- Ed25519 identity generation via browsermesh-primitives
- BroadcastChannel peer discovery
- Pod kind detection (window, iframe, worker, service-worker, etc.)
- Runtime capability detection (messaging, network, storage, compute)
- Wire protocol message factories (hello, hello-ack, goodbye, message, rpc-request, rpc-response)
- InjectedPod subclass for Chrome extension / bookmarklet injection
- Runtime convenience functions: installPodRuntime, createRuntime, createClient, createServer
