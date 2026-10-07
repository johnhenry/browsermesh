---
"@johnhenry/browsermesh-core": minor
---

- `GroupKeyManager.encrypt()`/`decrypt()` take an opt-in `padding` option (and the constructor a default) that pads plaintext to a size bucket before sealing, so ciphertext length reveals only the bucket. Off by default.
- The `stealth_save` / `stealth_restore` tools called `agent.saveState()` / `agent.restoreState()`, which `StealthAgent` does not have, so they always failed. They now call `hide()` / `reconstitute()` (a duck-typed agent exposing `saveState`/`restoreState` still works). The false "threshold-encrypted" wording is gone: the shards are not encrypted, and the tool descriptions say so.
- `padding` needs `@johnhenry/browsermesh-primitives` >= 0.3.0 and throws a clear error otherwise; the peer range is unchanged.
