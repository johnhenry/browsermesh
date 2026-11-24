---
"@johnhenry/browsermesh-discovery": minor
---

`StealthAgent` gains an opt-in `keyring` option (`StealthKeyring`): sealed state uses a v2 envelope with a key id (so keys rotate with overlap), a sequence number and issue time (older state is refused as replayed, `maxAgeMs` refuses stale state), and the agent id and message type as AES-GCM associated data, with a per-key message budget. New `sealStealthMessage` / `openStealthMessage` / `StealthError`, `tryReconstituteEncrypted()` (a quiet, counted failure for peers without the key, plaintext or foreign state) and `stats`. The single-`key` v1 path and the plaintext `hide()` / `reconstitute()` are unchanged. The README now states what StealthAgent hides and from whom; threshold key sharing is documented as a design only.
