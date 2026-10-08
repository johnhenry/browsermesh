---
"@johnhenry/browsermesh-apps": minor
---

`PaymentRouter` can now see the conditional `EscrowManager` (#229). New `attachEscrowManager(manager)`, `getEscrowManager()`, `listEscrows(podId?)` and `getEscrowById(id)` give one normalized view over the router's wire-level `SimpleEscrowBook` and the manager's contracts, and `startEscrowSweeper()` also expires (and refunds) the manager's due contracts, reporting them to `onExpired`. `SimpleEscrowBook` gains `listAll()`. Inbound `ESCROW_CREATE` still only records a hold; nothing existing changes unless a manager is attached.
