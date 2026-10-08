---
"@johnhenry/browsermesh-discovery": minor
---

Opt-in AES-256-GCM payload encryption for `StealthAgent` (#230, first half). New `deriveStealthKey(groupSecret, groupId)` (HKDF-SHA-256, one key per discovery group), `encryptStealthState` / `decryptStealthState` (random IV, agent id as AAD), and `StealthAgent#hideEncrypted()` / `#reconstituteEncrypted()` with a `key` constructor option. Plain `hide()` / `reconstitute()` are unchanged. Threshold key sharing, signed shards and anonymous DHT keys remain open in #230.
