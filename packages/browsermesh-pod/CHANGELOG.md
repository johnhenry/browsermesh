# Changelog

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
