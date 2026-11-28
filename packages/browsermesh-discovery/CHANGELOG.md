# Changelog

## 0.8.0

### Minor Changes

- bff088e: Fix three bugs (#434). Minor, because `SwimMembership` gains options (`maxPiggyback`, `retransmitMultiplier`, `maxQueuedUpdates`), `SwarmCoordinator` gains `stop()`, and the gossip behaviour changes.

  - `SwimMembership` now disseminates updates SWIM-style: each update rides up to `ceil(retransmitMultiplier * ceil(log2(n + 1)))` messages (default multiplier 3), least-transmitted first, at most `maxPiggyback` (default 8) per message, then is retired; updates a pod learns are passed on, and a message from an unknown peer introduces it. Seeds in a chain now converge. The wire format and the precedence rules are unchanged.
  - `SwarmCoordinator` (given `swim`) now drops a member on SWIM `left` as well as `dead`, brings it back on a higher-incarnation `alive`, chains callbacks already set on the SWIM instance, and has `stop()` to unhook.
  - Importing the package no longer prints Node's `ExperimentalWarning` about `localStorage`.

## 0.7.0

### Minor Changes

- 34687ff: The DHT that `createMeshNode({ enableDht })` runs can now store under the pod's own key and check what it is sent, both opt-in.

  - **discovery:** `DhtDiscoveryStrategy` takes `storePolicy` (handed to its `DhtNode`), `now`, `signStore(key, record)` (called by `announce` to sign the record it stores; a signer that throws stores nothing) and `onStoreRefused`; `strategy.storePolicy` and `dhtNode.storePolicy` report what is in force. With none of them the strategy is what it was.
  - **apps:** `createMeshNode({ enableDht, dhtSignStores, dhtStorePolicy, dhtStoreLifetimeMs })` and `createMeshDht({ signStores, identity, storePolicy, storeLifetimeMs })`. `dhtSignStores` signs the record the node announces with the pod's key (a `seq` that rises with every announce, an expiry 24 h ahead by default); `dhtStorePolicy: 'open' | 'owned'` makes this node check the stores it receives (`'owned'` holds only records that carry a valid proof, and needs `dhtSignStores`). Off by default. A node that does not check ignores the proof, so signing is safe in a mixed swarm; an `'owned'` node does not hold a record from a node that does not sign. With an older discovery package that ignores these options, `createMeshDht` throws instead of quietly storing unsigned.

## 0.6.0

### Minor Changes

- af7d3ab: Who may store under which DHT key. A `DHT_STORE` message may carry an optional proof `auth` (`signDhtStore`: the writer's Ed25519 key, a `seq`, an absolute expiry, and a signature over the key, the canonical value digest, `seq` and expiry); the stored value is unchanged, so readers of older nodes see what they always saw. `DhtNode` takes an opt-in `storePolicy`: in `mode: 'open'` an unsigned store is accepted as before unless the key is owned, and a verified proof owns a pod-id key (only that pod), a `stealth:<id>:shard3:<n>` key or an agent-anonymous 64-hex key (the first valid signer); in `mode: 'owned'` every store needs a proof and any key outside `openPrefixes` is owned by its first signer. An owned key is replaced only by its owner with a higher `seq`, and an entry never outlives its signed expiry. Bounded, named refusals (`value-too-large`, `store-full`, `writer-quota`, `rate-limited`, `lifetime-too-long`, `expired`, `stale-seq`, `owned-key`, `not-key-owner`, `unsigned-store`, `bad-auth`, `malformed`), counted in `storeStats` and passed to `onRefuse` with a short hash of the key and never the value. A node without a policy is unchanged (its `store()` now returns `{ stored: true }`); with one, a store answers with a promise and a ping reply carries `caps`. `StealthAgent` gains `ownedStores` (with an identity and shard format 3): each shard of an anonymous agent is stored under its own writer key derived from the identity (`deriveWriteSigner`, which refuses a non-deterministic signer), so the keys are unchanged and unlinked, group members who hold the lookup nonce can read but not store, and a refused store throws `store-refused`. New exports: `signDhtStore`, `verifyDhtStore`, `dhtStoreSigningBytes`, `deriveWriteSigner`, `canonicalJson`, `classifyStoreKey`, `podIdOfPublicKey`, `DHT_STORE_REFUSALS`, `DhtAuthError`.
- 6f993d0: Shard format 3, part one: a real checksum. `StealthAgent` takes `shardFormat` (`2` by default, which writes exactly what it always wrote; `3`, or `[2, 3]` to write both), `readFormats` (default `[2, 3]`) and the async `hideAsync()` / `reconstituteAsync()`. A format 3 shard record carries `checksum: "s256." + base64url(SHA-256(...))`, the whole digest over the shard's bytes, index, threshold, total, parity code and state length (no agent id, so an anonymous record names nothing). On the unsigned path it is a real corruption check where the character-code sum was not; on the signed path it is checked before the signature, so damage (`stats.shardCorrupt`) and a signer the reader does not trust (`shardBadSignature`) are counted apart, and the signature covers it instead of a separate data digest. Format 3 records are stored under different DHT keys (`stealth:<agentId>:shard3:<i>`, or the `lookup/3` label for anonymous keys), so an older peer never reads one and never mis-verifies it; a reader takes the newest complete write across both formats. Exports `stealthShardChecksum`. The synchronous `hide()` keeps writing format 2 and throws `async-required` if `shardFormat` includes 3.
- 6f993d0: Shard format 3, part two: Reed-Solomon parity. With `shardFormat` including 3 the state is cut into byte shards and `totalShards - threshold` parity shards of a systematic Reed-Solomon erasure code over GF(2^8) (polynomial 0x11d, Cauchy matrix), so any `threshold` of `totalShards` valid shards rebuild the state, data shards included: the defaults 3 of 5 survive two lost shards where the old XOR parity survived one data shard. `parity: 'xor'` keeps the old single-loss parity under the new checksum. A format 3 state also carries its byte length (a trailing NUL is no longer stripped) and must be well-formed UTF-8 text of at most 8 MiB in at most 64 shards; refusals are `not-well-formed`, `state-too-large`, `too-many-shards`. New exports `rsEncode`, `rsDecode`, `ParityError`, `MAX_RS_SHARDS`. Protects against lost shards, not forged ones, and is separate from the Shamir key sharing. No new dependency: the arithmetic is in the package, with the GF(2^8) table checked against the published QR code field values and the parity checked against a second implementation in the tests.
- a8b7057: On-demand share release round for threshold-shared group secrets. A group member asks the share holders for their shares when it needs the secret (`requestShareRelease`), instead of only holding shares dealt up front. A holder (`createShareHolder`, over the protocol channel named by `stealthReleaseChannel(agentId)`, `stealth:<agentId>:share:release`) answers only members of its roster: the request is signed by the member, bound to one holder, a time and a nonce, and names the agent only by a hash tag. A holder checks size and version, addressee and freshness, a per-requester rate limit, the signature, a replay cache, membership (before it looks at the tag, so a non-member learns nothing about what it holds), the epoch floor (`minEpoch`, `retire()`), and an optional `approve` hook; it answers with its signed share sealed to the requester (X25519, HKDF, AES-256-GCM) and signed by the holder, or a named refusal (`RELEASE_REFUSALS`). The reader verifies every share against the dealer, `minEpoch` and `holders`, stops at the threshold, and reports released, refused and unreachable holders; fewer than `t` valid shares throws `below-threshold` with those counts. Shares and the existing threshold module are unchanged (`v: 1`), the messages are new, and a peer that does not run the channel is simply unreachable. Off by default: nothing sends or answers a release request unless the application wires it. New exports: `createShareHolder`, `requestShareRelease`, `createReleaseRequest`, `createReleaseResponse`, `stealthReleaseChannel`, `stealthReleaseTag`, `RELEASE_REFUSALS`.

## 0.5.0

### Minor Changes

- b1b179f: Opt-in threshold sharing of the StealthAgent group secret (`dealStealthShares`, `reconstructStealthSecret`,
  `verifyStealthShare`, `thresholdEpochKeys`): the owner pod deals a fresh 32-byte secret `t`-of-`n` (Shamir over GF(2^8),
  through the audited `shamir-secret-sharing` library, a new dependency loaded on first use), signs each share over
  agent, group, epoch, index, holder and threshold, and holders recombine it from any `t` valid shares. Fewer than `t`
  shares recombine nothing; a share that was altered, relabelled or dealt by a dealer the reader does not name is refused
  and counted; epochs are never mixed, and `minEpoch` and `holders` refuse the shares of an earlier epoch or of a member
  who left. Off by default and separate from `StealthAgent`: no shard record, DHT key or envelope changes, so an older
  peer is unaffected. Design, threats and what is not protected: `docs/design/stealth-threshold.md`.

## 0.4.0

### Minor Changes

- 9963cac: `StealthAgent` can sign its shards and store them under keys that do not name the agent (#230).

  With an `identity` option (a `PodIdentity`), every shard the agent stores is signed (Ed25519, over the agent, the DHT key it lives under, its index, the write's sequence number, its content and the lookup nonce) and every shard it reads is verified: `hideSigned()` / `reconstituteSigned()` / `tryReconstituteSigned()` / `isRecoverable()`, and `hideEncrypted()` / `reconstituteEncrypted()` / `tryReconstituteEncrypted()` do the same. A shard that does not verify, is signed by a key the agent does not trust (its own, plus `trustedKeys`), or belongs to an older write is refused and counted in `stats`; the newest complete write is used. A shard with no signature (an older peer) is refused unless `allowUnsigned: true`. An agent with an identity throws `async-required` from the synchronous `hide()` / `reconstitute()` / `isViable()` rather than write or read unsigned by accident.

  With a `lookupNonce` (derive it with the new `deriveStealthLookupNonce(groupSecret, agentId, epoch)`) the DHT keys are `hex(SHA-256(agentId, nonce, index))` and the stored records carry no agent id, shard id or public key, so a DHT observer without the nonce cannot link a key to the agent or one agent's shards to each other by key.

  Opt-in: an agent without `identity` behaves exactly as before, including what it writes to the DHT. Agents with an identity read an unsigned shard as refused by default; that is the one default to know about when moving an existing agent to an identity (`allowUnsigned: true` reads old shards, or re-`hide` once). Shards are still plaintext slices unless the encrypted methods are used; threshold sharing of the key is not built (see the design note and the follow-up issue).

## 0.3.1

### Patch Changes

- 505c215: Defaults that still carried the project's earlier name now use `browsermesh`: the default identity's display and full names (the earlier short aliases stay), the embed widget's default container id (`#browsermesh`; an existing `#clawser` element is still found when `#browsermesh` does not exist, and an explicit `containerId` is never replaced) and the channel relay's default sender. The `ChannelRelay` BroadcastChannel name and the discovery SharedWorker name keep their earlier values on purpose, because they are rendezvous points between pages that may run different releases; both are documented in the code.
- 50835f4: `DhtNode` takes an optional `now` clock (default `Date.now`) that its stored values expire against, so TTL expiry can be driven without waiting. `MeshRouter` announces a routed message that ran out of TTL as a `drop` event with reason `ttl-expired` (it was only logged before).

## 0.3.0

### Minor Changes

- aaa4903: `StealthAgent` gains an opt-in `keyring` option (`StealthKeyring`): sealed state uses a v2 envelope with a key id (so keys rotate with overlap), a sequence number and issue time (older state is refused as replayed, `maxAgeMs` refuses stale state), and the agent id and message type as AES-GCM associated data, with a per-key message budget. New `sealStealthMessage` / `openStealthMessage` / `StealthError`, `tryReconstituteEncrypted()` (a quiet, counted failure for peers without the key, plaintext or foreign state) and `stats`. The single-`key` v1 path and the plaintext `hide()` / `reconstitute()` are unchanged. The README now states what StealthAgent hides and from whom; threshold key sharing is documented as a design only.

### Patch Changes

- 15d5f74: File headers, comments, log tags, READMEs and examples no longer carry the name of the private monorepo this code was extracted from. No behaviour change, with these naming additions: `BrowsermeshEmbed` is the primary export of `@johnhenry/browsermesh-embed` and `ClawserEmbed` stays as a deprecated alias; the debug switch is now the `browsermesh_debug` localStorage key and the `[browsermesh:silent-catch]` console prefix, and the old `clawser_debug` key still works as a deprecated alias.

## 0.2.1

### Patch Changes

- e2b4758: Share browser-safe mesh address parsing through primitives and discovery, retaining case-sensitive IDs and query strings. Remove the Node-only mesh-fetch factory path. Add explicit HTTP body mode and Request input with bounded byte-preserving uploads, native multipart headers, cancellation and correct HEAD/bodyless responses, while retaining the default structured JSON-body convention. HTTP bodies are buffered, not streamed.

## 0.2.0

### Minor Changes

- dbb35b7: Opt-in AES-256-GCM payload encryption for `StealthAgent` (#230, first half). New `deriveStealthKey(groupSecret, groupId)` (HKDF-SHA-256, one key per discovery group), `encryptStealthState` / `decryptStealthState` (random IV, agent id as AAD), and `StealthAgent#hideEncrypted()` / `#reconstituteEncrypted()` with a `key` constructor option. Plain `hide()` / `reconstitute()` are unchanged. Threshold key sharing, signed shards and anonymous DHT keys remain open in #230.

## 0.1.0

### Minor Changes

- 774e86e: `StealthAgent` / `ShardCollector`: the parity shards are now actually used. `reconstitute()` recovers from the loss of one data shard (previously any missing shard threw). Docs and comments no longer imply encryption: the shards are plaintext slices plus XOR parity, keyed by agent id, with a non-cryptographic checksum; encrypt the state yourself before `hide()` if it is sensitive.

## 0.0.6

### Patch Changes

- Peer range on `@johnhenry/browsermesh-primitives` is now `>=0.2.0 <1.0.0`, so it no longer admits primitives 0.1.x, whose `PodIdentity.verify` takes `(publicKey, data, signature)`.

## 0.0.5

### Patch Changes

- `sw-routing.mjs`'s `MeshFetchRouter.route()` got its first real caller (`@johnhenry/browsermesh-apps`'s new `serverless-fetch.mjs`, part of BrowserMesh Serverless), which surfaced a real, previously-latent bug: a non-string `result.body` was always `JSON.stringify()`'d before building the `Response`, silently mangling a `Uint8Array`/`ArrayBuffer` into a `{"0":..,"1":..}` object dump instead of real bytes — never caught before because nothing called this router for real. Fixed to pass binary bodies straight to `new Response()`, which accepts `BufferSource` natively.

## 0.0.4

### Patch Changes

- Documentation only: corrected `sw-routing.mjs`'s stale `STATUS: INTEGRATED — wired into ClawserPod lifecycle` header comment now that `parseMeshRequest()`/`MeshFetchRouter` has a real caller — `@johnhenry/browsermesh-apps`'s `browserMeshFetch()` reuses `parseMeshRequest()` directly. No code/behavior change in this package.

## 0.0.3

### Patch Changes

- `RelayStrategy#connect()`'s 10s WebSocket-connection-timeout guard was never captured, cleared, or unref'd, so it kept the event loop alive for the full 10s after every connection attempt, success or failure, not just genuine timeouts. The handle is now cleared in both the `onopen` success path and the `onerror` path.

## 0.0.2

### Patch Changes

- Peer dependency ranges were all ">=0.0.0", which accepts any version including a future incompatible major. They are now bounded at both ends: at least the version actually required, and below 1.0.0.

  browsermesh-apps declared core, transport and discovery as required peers but never imports any of them at runtime; every reference is a JSDoc type import, and the objects themselves are injected by the caller (discovery and transportNegotiator are optional and guarded at every use; wallet is required but supplied by the consumer, who therefore already has core). Since npm 7 installs peer dependencies automatically, that made installing apps pull in three packages it only needs for types. They are marked optional in peerDependenciesMeta.

## 0.0.1

### Patch Changes

- Feature-detect the platform floors instead of crashing on them.

## 0.0.0

Extracted from the private `clawser` monorepo and imported into the `@johnhenry` npm scope as part of the browsermesh monorepo consolidation. Previously published unscoped as `browsermesh-discovery@0.1.0` (2026-07-17, manual publish, never CI-automated). Per family convention, the version restarts at 0.0.0 on scope import.
