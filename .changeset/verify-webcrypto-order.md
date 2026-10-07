---
"@johnhenry/browsermesh-primitives": minor
---

BREAKING: `PodIdentity.verify` now takes `(publicKey, signature, data)`, the same order as `crypto.subtle.verify`; it previously took `(publicKey, data, signature)`. Swap the last two arguments at every call site. To avoid silently returning `false` for old-order callers, a call whose `signature` is not 64 bytes while `data` is exactly 64 bytes throws a `TypeError` naming the new order. `sign` is unchanged. (The 0.1.0 object-form overload is removed.)
