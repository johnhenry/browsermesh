---
"@johnhenry/browsermesh-core": patch
"@johnhenry/browsermesh-transport": patch
---

Raise the `@johnhenry/browsermesh-primitives` peer range to `>=0.3.0 <1.0.0` and import `padTo` / `unpad` by name. Padding (primitives 0.3.0) no longer needs a runtime "primitives too old" check; an older primitives is now rejected by the peer range instead (#231). Also makes the `TransportHealthCheck` and `startAutoSync` tests deterministic with mock timers (#232).
