# Changelog

## 0.1.0

### Minor Changes

- Fixed a blocking bus-shadowing bug: `EmbeddedPod` declared its own private `#listeners`/`on`/`off`/`emit`, shadowing `Pod`'s own private bus. Because JS private fields aren't polymorphic, `Pod`'s internal `_emit('peer:found', ...)` (and `'ready'`/`'peer:lost'`/`'message'`/`'error'`/`'shutdown'`) always wrote into `Pod`'s listener map, while a host's `pod.on(...)` registered into `EmbeddedPod`'s separate, dead map — peer/lifecycle events never reached anything. `on()`/`off()` are now inherited directly from `Pod`, and a single public `emit(event, data)` calls the protected `_emit()`. `sendMessage()` now actually emits the `'response'` event its own README already documented but never fired.

- Added the real widget: vanilla DOM into the existing `containerId` config contract (not a Web Component), using `container.attachShadow({mode:'open'})` for CSS isolation. New `src/dom.mjs` (skeleton, theming via `--bm-accent`/`--bm-bg`/`--bm-fg` CSS custom properties, status line, message log, input form), kept separate from `index.mjs`. `index.mjs` gains an idempotent `mount()` that auto-runs from the constructor when the container already exists, or is callable explicitly for SPA "container created later" cases. The widget is driven entirely off `Pod`'s real state/events.

## 0.0.1

### Patch Changes

- Peer dependency ranges were all ">=0.0.0", which accepts any version including a future incompatible major. They are now bounded at both ends: at least the version actually required, and below 1.0.0.

  browsermesh-apps declared core, transport and discovery as required peers but never imports any of them at runtime; every reference is a JSDoc type import, and the objects themselves are injected by the caller (discovery and transportNegotiator are optional and guarded at every use; wallet is required but supplied by the consumer, who therefore already has core). Since npm 7 installs peer dependencies automatically, that made installing apps pull in three packages it only needs for types. They are marked optional in peerDependenciesMeta.

## 0.0.0

Extracted from the private `clawser` monorepo and imported into the `@johnhenry` npm scope as part of the browsermesh monorepo consolidation. Previously published unscoped as `clawser-embed@0.1.1` (2026-07-17, manual publish, never CI-automated). Per family convention, the version restarts at 0.0.0 on scope import.
