# StealthAgent: threshold sharing of the group secret

Status: built, opt-in, in `@johnhenry/browsermesh-discovery` (`stealth-threshold.mjs`). Tracking issue: #328 (the rest of
#230). Signed shards and agent-anonymous DHT keys (`SHA-256(agentId, nonce, index)`, with `deriveStealthLookupNonce`) came
first and are unchanged. The three decisions the issue left open were taken as its recommendations, conservatively; they
are listed at the end so the owner can overrule any of them.

## Where things stand

`StealthAgent` shards an agent's state across the DHT. Opt-in sealing exists: AES-256-GCM under a key derived from a
**group secret** (`deriveStealthKey` / `StealthKeyring`), with key ids for rotation, a sequence number and issue time for
replay bounding. The same secret derives the lookup nonce that makes the DHT keys unguessable
(`deriveStealthLookupNonce(secret, agentId, epoch)`). Every member holds that secret, so one leak exposes all state. This
change splits the secret so that no single member holds it.

## What is built

Nothing changes on the existing wire: shard records, DHT keys, the sealed envelope and `StealthAgent` are untouched. A new,
separate module deals and recombines the **group secret** `K` (32 random bytes); `K` is then given to the existing
`StealthKeyring.add(...)` and `deriveStealthLookupNonce(...)` exactly as a plain group secret would be. Off by default: no
`StealthAgent` option changes, and nothing is dealt unless the owner calls `dealStealthShares`.

- **Split.** Shamir secret sharing over GF(2^8) (reduction polynomial 0x11b), byte-wise, `t`-of-`n`, `2 <= t <= n <= 255`,
  from the audited library `shamir-secret-sharing` (below). Coefficients come from `crypto.getRandomValues` inside it.
  A share is the 32 evaluation bytes followed by its x coordinate (the **index**, 1..255; the library draws the indices at
  random without repetition, so they are not 1..n in order).
- **Dealer.** The agent's owner pod: the identity that already signs its shards (`identity.sign`, `identity.rawPublicKey`).
  The dealer generates `K`, splits it, signs each share and hands it to its holder over a channel the caller already
  trusts. The dealer sees `K` (that is the dealer model; see "What is not protected").
- **Signed share** (`v: 1`, plain JSON-able object): `agentId`, `groupId`, `epoch`, `threshold`, `total`, `index`,
  `holder`, `keyCheck`, `share` (base64url), `dealer` (raw Ed25519 public key, base64url), `sig`. The signature is Ed25519
  over a domain-separated (`browsermesh-stealth-threshold/1`), length-prefixed encoding of all of those fields except
  `sig`, so a share cannot be moved to another agent, group, epoch, index, holder or threshold, nor have its bytes changed.
  `dealer` in the share is a claim: a reader accepts a share only if that key is in the reader's own `trustedDealers`.
- **Key check.** `keyCheck = SHA-256(domain, agentId, groupId, epoch, K)`, signed into every share. After recombination the
  reader recomputes it and refuses the result if it differs. This detects what a signature cannot: a dealer who signed
  shares of different secrets (a mis-deal), or a combination that was not made of `t` consistent shares. `K` has 256 bits of
  entropy by construction (the dealer generates it, a caller-supplied secret is not accepted), so the check lets nobody
  guess `K`.
- **Recombine** (`reconstructStealthSecret`): each share is verified first (shape, agent, group, dealer, signature,
  epoch >= `minEpoch`, holder allowed, index equal to the share's x byte). Refused shares are counted by reason and never
  used. Among the valid shares of one epoch it needs `t` distinct indices; it combines exactly `t` of them, checks
  `keyCheck`, and returns `K`. With fewer than `t` valid shares it throws `below-threshold` and returns nothing (it never
  returns the library's garbage value for too few shares). Shares of different epochs are never mixed; the newest epoch
  that has enough valid shares is used.
- **Use.** `thresholdEpochKeys(secret, { agentId, groupId, epoch, keyring })` adds `K` to a `StealthKeyring` under the key id
  `e<epoch>` (made current) and returns the `lookupNonce` for that epoch; pass both to `StealthAgent`.

## Share holders

Default: the group members (`holders` = the member pod ids, `n` = group size) with `t` = a majority (`floor(n/2) + 1`).
An explicit `holders` list of dedicated custodians is the same call. A holder name is any non-empty string without control
characters; it is signed into the share and is only a label to the library (the caller's channel decides who actually gets
the share). `t = 1` is refused (it is the plain secret); `n` above 255 is refused.

## Epochs, leaving, revocation

An epoch is one `K`, one set of shares, one key id (`e<epoch>`) and one lookup nonce, so a new epoch also moves the shards to
new DHT keys. When a member leaves:

1. The dealer deals `epoch + 1` to the remaining holders (a fresh `K`; the old shares are not reused).
2. The remaining members recombine `K'` and install it as the current key.
3. The agent re-seals the **latest** state under `K'` and stores it at the new keys (a new `StealthAgent` with the new
   keyring and nonce).
4. Members drop their old shares, and `StealthKeyring.remove` retires the old key once nothing needs the old state.
5. Readers pass `minEpoch` (and the current `holders`) so a share of an earlier epoch, or one dealt to the leaver, is
   refused even if it is still validly signed.

Old epochs stay readable only while the application keeps their keys.

## Threats and what each party learns

| Party | Learns | Does not learn |
| --- | --- | --- |
| One holder | its own share (random bytes, independent of `K` when `t >= 2`), the agent, group, epoch, `t`, `n`, its holder label and `keyCheck` | anything about `K` or the state; which other holders exist beyond what the application tells it |
| `t - 1` or fewer holders together | their shares and the public fields; nothing about `K` (information-theoretic: every value of `K` is equally likely given their shares) | `K`, the state, the lookup nonce |
| An observer of the DHT | unchanged by this change (ciphertext under unguessable keys) | shares: they do not travel with the shards |
| An observer of a share in transit | the share itself, if the channel is not confidential; `t` of them make `K` | a signed share cannot be altered or re-labelled without the signature failing |
| A forger without the dealer key | nothing usable | cannot make a share a reader accepts |
| `t` holders together | `K`, so the state of that epoch | |

## What is NOT protected

- A compromised dealer, at dealing time or later if it keeps `K`: it knows everything. Distributed key generation (no dealer
  ever sees `K`) is out of scope.
- `t` colluding or compromised holders. Availability fails if more than `n - t` holders are lost.
- A member who reconstructed `K` still has it: leaving members need a new epoch and a re-seal, and what they already read
  stays read. Re-sealing covers the latest state only.
- Share transport: shares are signed, not encrypted. They must travel over channels that are authenticated and confidential;
  this module sends nothing itself.
- A holder that releases its share to the wrong party. The on-demand release round (decision (b)) is not built; the share
  format is the unit it would carry.
- Traffic analysis, the existence of the agent, state size and access timing: unchanged.
- Memory: `K` and shares are `Uint8Array`s the caller should overwrite (`fill(0)`) after use; JavaScript gives no guarantee
  that copies are gone.
- The DHT still accepts a `store` from anyone for any key; a signed shard can be made unusable by an overwrite (refused and
  counted, not accepted). Unchanged here.

## The dependency

`shamir-secret-sharing` 0.0.4 (Privy; zero dependencies; independently audited by Cure53 and Zellic; Apache-2.0), pinned to
the exact version and imported lazily on the first deal or recombine, so a page that never uses threshold sharing loads
none of it. It is the smallest audited implementation found; the repository has no Shamir or GF(2^8) code and none of its
existing dependencies (`@noble/*` is present only through `@johnhenry/wsh`) provides it, and field arithmetic is not
hand-rolled here. Differences from the first sketch of this note: the x coordinates are random distinct bytes, not 1..n.
The test vectors pin the field: a degree-1 and a degree-2 polynomial with fixed coefficients are evaluated with a small
independent multiplier in the test (checked against the known product 0x57 * 0x83 = 0xc1) and the library must recombine
them.

## Decisions taken (recommendations of the issue; the owner may overrule)

1. **Dealer model (a)**: a trusted dealer, the agent's owner pod, hands shares to named holders at setup. The share-release
   API for on-demand recovery (b) is reserved as the protocol-channel name `stealth:<agentId>:share:release`, authorised per
   root; it is not built, and the signed share is the message it would carry. (c) is out of scope.
2. **Holders**: group members by default, `t` a majority, an explicit custodian list as an option.
3. **Epoch on every leave**: new `K`, new key id, new lookup nonce; re-seal only the latest state; old shares refused through
   `minEpoch`.

## Also not done (smaller, independent, left)

- A real checksum in place of the char-code sum, and Reed-Solomon parity: both change the shard record that older peers
  read and verify, so they need version negotiation of their own.
- Ownership of DHT entries is a DHT concern.
