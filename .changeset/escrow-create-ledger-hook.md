---
'@johnhenry/browsermesh-apps': minor
---

An inbound wire `ESCROW_CREATE` can become a real, funded contract through a ledger hook the deployment supplies (#239).

`PaymentRouter.attachEscrowLedger(mutateLedger, opts)` takes the `mutateLedger(op, amount, podId, memo)` hook shape `EscrowManager` already accepts; `createMultiPartyLedgerHook(ledger)` is the documented default shape for a per-pod `MultiPartyCreditLedger`. The authenticated sender is the payer: a `payerPodId` in the message that differs is refused (`payer-mismatch`) before any ledger call; a hook that reports an insufficient balance leaves nothing held; the message's `escrowId` is an idempotency key so a repeat is not charged twice; amount, memo, timeout, id and payee are bounded; every refusal is reported to an `onAudit` callback without an amount. Failures are an `EscrowWireError` with a named `code` (`router.handleEscrowCreate()`), and the wire subscriber resolves `{ ok, code }`. `EscrowManager` no longer requires a `creditLedger` when it is given a `mutateLedger`.

Nothing is on by default: with no hook attached, an inbound `ESCROW_CREATE` is only mirrored in the `SimpleEscrowBook` exactly as before, and `attachEscrowManager({ delegateWire })` is unchanged. No new wire fields are required; a peer that sends none of the new ones (`escrowId` is the one the hook path needs, and the book's own records already carry it) is unaffected.
