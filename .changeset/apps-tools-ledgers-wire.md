---
"@johnhenry/browsermesh-apps": minor
---

- `registerMeshTools()` registers `iot_list`/`iot_send`/`iot_telemetry` only when you pass `{ iotBridge }` / `{ iotTelemetry }` as a fourth argument (the package ships no IoT implementation, so they were permanently "not initialized"). The default is now the 12 non-IoT tools; pass both options for the old count of 15. The bridge duck types are documented and checked up front.
- One implementation per public name for ledgers and escrow. `CreditLedger` stays the single-owner ledger (`payments.mjs`) and `EscrowManager` the conditional escrow (`peer-escrow.mjs`), exactly what the package index exported already. The two unreachable namesakes are renamed and now exported under their own names: `peer-payments.mjs`'s multi-peer ledger is `MultiPartyCreditLedger`, and `payments.mjs`'s flat escrow record is `SimpleEscrowBook` (what `PaymentRouter.getEscrow()` returns). `EscrowManager` now accepts a `MultiPartyCreditLedger` as well as a `CreditLedger`, and rejects a ledger of neither shape unless `mutateLedger` is given. README table added.
- `TimestampAuthority` takes an optional `now` clock, which makes the outlier-rejection tests deterministic (the 'split clocks with some rejected' test only passed when two `Date.now()` reads returned the same millisecond).
- The raw `PeerNode.onIncomingData()` subscribers were audited: all already parse JSON text through `decodeWireData`. A test now fails if one is added without it, and mesh-sync and the relay host/backend are exercised over a string-only wire and a real WebRTC data channel.
