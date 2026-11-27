---
"@johnhenry/browsermesh-apps": minor
---

`createMeshNode({ realm })`: a node hosts and joins one realm. The realm exchange (descriptor store, verifier, prover) is wired through the existing link-admission seam for wsh and WebRTC, `node.realm` carries `present()`, `renew()`, `status()` and `setCredential()`, a `realm` protocol on the protocol seam renews a grant (and delivers descriptor updates) to a peer that holds a live grant, and an optional `autoRenew` timer re-presents before `notAfter`. The realm package is an optional peer dependency, `import()`ed lazily; without the option nothing changes.
