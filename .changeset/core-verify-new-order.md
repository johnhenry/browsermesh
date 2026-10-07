---
"@johnhenry/browsermesh-core": minor
---

Follow `PodIdentity.verify`'s new `(publicKey, signature, data)` order internally. `MeshIdentityManager.verify(publicKeyBytes, data, signature)` and the wallet's `verify` keep their existing signatures. The `browsermesh-primitives` peer range is raised to `>=0.2.0`, since this release requires the new order.
