---
'@johnhenry/browsermesh-discovery': minor
---

Opt-in threshold sharing of the StealthAgent group secret (`dealStealthShares`, `reconstructStealthSecret`,
`verifyStealthShare`, `thresholdEpochKeys`): the owner pod deals a fresh 32-byte secret `t`-of-`n` (Shamir over GF(2^8),
through the audited `shamir-secret-sharing` library, a new dependency loaded on first use), signs each share over
agent, group, epoch, index, holder and threshold, and holders recombine it from any `t` valid shares. Fewer than `t`
shares recombine nothing; a share that was altered, relabelled or dealt by a dealer the reader does not name is refused
and counted; epochs are never mixed, and `minEpoch` and `holders` refuse the shares of an earlier epoch or of a member
who left. Off by default and separate from `StealthAgent`: no shard record, DHT key or envelope changes, so an older
peer is unaffected. Design, threats and what is not protected: `docs/design/stealth-threshold.md`.
