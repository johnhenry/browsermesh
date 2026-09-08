# Changelog

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
