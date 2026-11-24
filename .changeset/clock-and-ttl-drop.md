---
'@johnhenry/browsermesh-discovery': patch
'@johnhenry/browsermesh-apps': patch
---

`DhtNode` takes an optional `now` clock (default `Date.now`) that its stored values expire against, so TTL expiry can be driven without waiting. `MeshRouter` announces a routed message that ran out of TTL as a `drop` event with reason `ttl-expired` (it was only logged before).
