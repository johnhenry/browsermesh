# Changelog

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
