# Changelog

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
