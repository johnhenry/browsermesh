# StealthAgent: threshold sharing of the state key (design, not built)

Status: design only. Nothing in this document is implemented. Tracking issue: #230.

## Where things stand

`StealthAgent` shards an agent's state across the DHT. Opt-in sealing exists:
AES-256-GCM under a group key (`deriveStealthKey` / `StealthKeyring`), with key
ids for rotation, a sequence number and issue time for replay bounding, and the
agent id and message type as associated data. The group secret is held by every
member. That is the custody question this design addresses.

## Decision

Threshold sharing is **not built** in this change. Reasons:

1. The issue frames it as something to decide ("decide whether to add ...") and
   its follow-up calls key custody "a design call", not a requirement.
2. The construction is easy (Shamir over GF(256)); the hard parts are around it
   (who deals the shares, how members authenticate to each other, what happens
   when a member leaves) and need an owner decision, not a patch.
3. Shipping a splitter without distribution and authentication would give a
   name that promises more than the code does.

## Construction (if built)

- Secret: a 32-byte per-agent (or per-epoch) key `K`; the state is sealed under
  `K` with the existing v2 envelope.
- Split: Shamir secret sharing over GF(2^8) (reduction polynomial 0x11b),
  byte-wise: for each byte of `K` pick a random polynomial of degree `t-1` with
  that byte as the constant term, evaluate at `x = 1..n` (`x` is the share
  index, never 0, at most 255 shares). A share is `index || 32 bytes`.
- Reconstruct: Lagrange interpolation at `x = 0` from any `t` shares.
  Fewer than `t` shares reveal nothing about `K` (information-theoretic).
- Test vectors (to write with the implementation): fixed polynomial
  coefficients with expected shares; every `t`-subset of a `(3,5)` split
  reconstructs; every `(t-1)`-subset yields a value different from `K` for a
  fixed seed; the field tables against known products (e.g. 0x57 * 0x83 =
  0xc1).
- Randomness: coefficients from `crypto.getRandomValues` only.
- Plain Shamir has no integrity: a wrong or malicious share silently yields a
  wrong key. Pair it with the AEAD (a wrong key fails authentication, which is
  detected but does not say which share was bad) and with signed shares.

## Share distribution

Shares must not travel with the shards they protect. Options, in increasing
cost: (a) the dealer hands shares to `n` named group members over existing
authenticated channels (the dealer is a trusted party at setup); (b) members
each hold a share and the group runs a recovery round on demand, each releasing
its share only to a requester it authorises (needs the signed-identity and
capability machinery already in the mesh); (c) a distributed key generation so
no dealer ever sees `K` (large, out of scope).

Each share would be signed by its holder's or the dealer's Ed25519 identity and
bound to `(agentId, epoch, index)`, so a share cannot be substituted across
agents or epochs.

## What it would protect

- Against: loss or compromise of fewer than `t` share holders; a single member
  leaking the group secret (today any one leak exposes all state).
- It would allow: rotating `K` per epoch and re-dealing when membership changes.

## What it would not protect

- Traffic analysis, existence of the agent, state size, access timing: unchanged.
- A dealer who is compromised at setup, or `t` colluding holders.
- Availability if more than `n - t` holders are lost.
- A member who legitimately reconstructed `K` still has it afterwards; leaving
  members require a new epoch key and re-sealing.

## Open decisions for the owner

1. Dealer model (a, b or c above) and who the dealer is.
2. Share holders: group members, or dedicated custodians?
3. Epoch policy when a member leaves; interaction with `StealthKeyring`
   (`keyId` naturally identifies the epoch).
4. Whether signed shards and agent-anonymous DHT keys (`SHA-256(agentId ||
   nonce)`) ship first, since they matter more for the stated threat model than
   splitting the key.
