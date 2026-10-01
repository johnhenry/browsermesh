---
"@johnhenry/browsermesh-pod": minor
---

Issue #185 item 6 (the hosted-pods supervisor) ground-level support in `host-protocol.mjs`: `InMemoryPodHostDriver` now emits a structured `EXIT` event payload — `{ name, code?, reason?: 'drained'|'crashed'|'host-lost'|'evicted', restartable: boolean }` — on both `drain()` (`reason: 'drained'`, `restartable: false`) and a new test-only `crash(name, { code })` method (`reason: 'crashed'`, `restartable: true`), so a supervisor can tell an intentional stop from a failure without guessing. The podspec gains an optional `links` section — `{ parent?, hostedBy?, detachOnParentExit? }` (validated: non-empty strings, boolean) — so a spawn can declare its place in a parent/child supervision tree.
