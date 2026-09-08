# Changelog

## 0.1.1

### Patch Changes

- Peer dependency ranges were all ">=0.0.0", which accepts any version including a future incompatible major. They are now bounded at both ends: at least the version actually required, and below 1.0.0.

  browsermesh-apps declared core, transport and discovery as required peers but never imports any of them at runtime; every reference is a JSDoc type import, and the objects themselves are injected by the caller (discovery and transportNegotiator are optional and guarded at every use; wallet is required but supplied by the consumer, who therefore already has core). Since npm 7 installs peer dependencies automatically, that made installing apps pull in three packages it only needs for types. They are marked optional in peerDependenciesMeta.

## 0.1.0

### Minor Changes

- DEFAULT_ICE_SERVERS is now empty. It was Google STUN, so every pairing attempt disclosed the device public IP to a third party, and mergeIceServers([]) returned Google anyway. Anyone relying on the default for NAT traversal must now configure a STUN or TURN server explicitly.

  state gains a failed value. A remotely-failed handshake reports failed in every browser and never closed (measured on WebKit, Chromium 153, Firefox 155), and only the closed branch moved the state, so a dead connection reported connecting forever with isOpen never going false.

  Remote ICE candidates arriving before the remote description are now held and applied instead of discarded. A peer gathers in 1-2ms while an answer crosses a signaling server, so on a real network that was all of them.

  The relay client re-announces its capabilities after an auto-reconnect, so a peer does not silently become undiscoverable after a transient drop.

## 0.0.0

Extracted from the private `clawser` monorepo and imported into the `@johnhenry` npm scope as part of the browsermesh monorepo consolidation. Previously published unscoped as `browsermesh-transport@0.1.0` (2026-07-17, manual publish, never CI-automated). Per family convention, the version restarts at 0.0.0 on scope import.
