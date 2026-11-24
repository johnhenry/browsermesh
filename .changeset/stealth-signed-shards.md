---
'@johnhenry/browsermesh-discovery': minor
---

`StealthAgent` can sign its shards and store them under keys that do not name the agent (#230).

With an `identity` option (a `PodIdentity`), every shard the agent stores is signed (Ed25519, over the agent, the DHT key it lives under, its index, the write's sequence number, its content and the lookup nonce) and every shard it reads is verified: `hideSigned()` / `reconstituteSigned()` / `tryReconstituteSigned()` / `isRecoverable()`, and `hideEncrypted()` / `reconstituteEncrypted()` / `tryReconstituteEncrypted()` do the same. A shard that does not verify, is signed by a key the agent does not trust (its own, plus `trustedKeys`), or belongs to an older write is refused and counted in `stats`; the newest complete write is used. A shard with no signature (an older peer) is refused unless `allowUnsigned: true`. An agent with an identity throws `async-required` from the synchronous `hide()` / `reconstitute()` / `isViable()` rather than write or read unsigned by accident.

With a `lookupNonce` (derive it with the new `deriveStealthLookupNonce(groupSecret, agentId, epoch)`) the DHT keys are `hex(SHA-256(agentId, nonce, index))` and the stored records carry no agent id, shard id or public key, so a DHT observer without the nonce cannot link a key to the agent or one agent's shards to each other by key.

Opt-in: an agent without `identity` behaves exactly as before, including what it writes to the DHT. Agents with an identity read an unsigned shard as refused by default; that is the one default to know about when moving an existing agent to an identity (`allowUnsigned: true` reads old shards, or re-`hide` once). Shards are still plaintext slices unless the encrypted methods are used; threshold sharing of the key is not built (see the design note and the follow-up issue).
