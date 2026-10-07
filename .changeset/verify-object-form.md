---
"@johnhenry/browsermesh-primitives": minor
---

Add the canonical object form `PodIdentity.verify({ publicKey, signature, message })` (and `identity.sign({ message })`), matching the sibling libraries. The positional `verify(publicKey, data, signature)` form is unchanged; its argument order is now documented loudly because it differs from WebCrypto and wsh (key, signature, data).
