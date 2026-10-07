---
"@johnhenry/browsermesh-discovery": minor
---

`StealthAgent` / `ShardCollector`: the parity shards are now actually used. `reconstitute()` recovers from the loss of one data shard (previously any missing shard threw). Docs and comments no longer imply encryption: the shards are plaintext slices plus XOR parity, keyed by agent id, with a non-cryptographic checksum; encrypt the state yourself before `hide()` if it is sensitive.
