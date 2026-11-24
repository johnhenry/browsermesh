---
"@johnhenry/browsermesh-apps": minor
---

`PaymentRouter.attachEscrowManager(manager, { delegateWire: true })` hands an inbound `ESCROW_CREATE` to the conditional `EscrowManager` (the sending pod is the payer and is debited through the manager's ledger) instead of only recording it in the router's wire book. Off by default: without the option nothing changes. The manager needs a per-pod ledger (`MultiPartyCreditLedger`, or a `mutateLedger` hook).
