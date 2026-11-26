# Discovery records: shard checksum, shard parity, who may store, on-demand share release

Status: designed in this note; all four items are built in `@johnhenry/browsermesh-discovery` (each item's status is in
"Staged order"). Tracking issue: #359 (left over from #328 / PR #357). The owner decided (2026-11-25) to build all four, each with
version negotiation so older peers keep working. Everything here is **off by default**: with no option set, every record, key,
message and refusal is exactly what the package produced before.

Read first: `stealth-threshold.md` (the key shares), `docs/security.md` ("Discovery and StealthAgent"), and the code cited
below (line numbers are from `main` at the time of writing).

Two kinds of "shard" are in play and they are different things:

- **State data shards** (`StealthAgent`, `ShardDistributor`): slices of the agent's state string, plus parity, stored in the
  DHT so the state survives lost holders. They protect *availability* of the state.
- **Key shares** (`stealth-threshold.mjs`): Shamir shares of the 32-byte group secret `K`. They protect *who can read* the state.

Items 1 and 2 are about the first kind; item 4 about the second; item 3 about the DHT that stores the first kind (and anything
else).

## What exists today

### Shard records (items 1 and 2)

- **Forming.** `ShardDistributor.#splitState` (`stealth.mjs:570-621`) cuts the blob into `threshold` equal slices of UTF-16
  code units, pads the last with `\0` (`:580`), then makes `total - threshold` parity shards; every parity shard is the XOR of
  all data slices (`:598-615`; the "rotation" index runs over every slice, so all parity shards are identical, as the module
  header says at `:12-14`). Chunk checksum is `simpleChecksum`: the sum of char codes mod 2^32 (`:397-404`).
- **Unsigned record** (`StateShard.toJSON`, `:482-491`): `{ shardId, agentId, data, threshold, total, checksum }`, stored at
  `stealth:<agentId>:shard:<i>` (`:630-636`). No version field. A reader (`ShardCollector.collect`, `:671-683`) builds a
  `StateShard` from the JSON, which ignores unknown fields (`fromJSON` passes the object to a destructuring constructor,
  `:496`), and keeps it when `verify()` (`:472`) says the char-code sum matches. A field it does not know is ignored; a
  `checksum` that is not that number is a failed `verify()`: the shard is silently dropped.
- **Signed record** (`#hideSignedNow`, `:974-1005`): `{ ...shard JSON, v: 2, i, seq, sig }`, or with a `lookupNonce`
  `{ v: 2, i, data, checksum, seq, sig }` (`:987-988`) at `hex(SHA-256("browsermesh-stealth/lookup/1\0agent\0nonce\0i"))`
  (`:943-951`). The signature is Ed25519 over a text of agent, key, index, `seq`, the reader's own threshold and total,
  the `checksum` number, the nonce and `SHA-256(data)` (`#signedText`, `:954-956`).
- **Verifying a signed record** (`#collectSigned`, `:1018-1066`): a record without `sig` is an older writer's: refused and
  counted (`shardUnsigned`) unless `allowUnsigned` (`:1028-1037`); otherwise `rec.i`, `data` (string), `checksum` and `seq`
  (both safe integers) must have those types, else `shardBadSignature` (`:1040`); the signature is checked against the agent's
  own key and `trustedKeys` over the text rebuilt from the reader's own configuration. **The reader never recomputes the
  char-code sum on the signed path**: the record's `checksum` is only signed metadata there, and `SHA-256(data)` in the text is
  what ties the signature to the bytes. The newest `seq` with at least `threshold` valid shards wins (`:1056-1064`).
- **Versions today.** Signed records say `v: 2`; the sealed envelope has `v1.` / `v2.` prefixes (`:73`, `:212`); unsigned shard
  records have no version. Nothing reads `v` on a shard record: a reader that sees a different `v` does what it does with
  `v: 2`. So there is no way today for a record to say "I follow rules you do not know", which is why a new record shape needs a
  new key namespace (below), not just a new field.
- **Recovery** (`ShardCollector.reconstruct`, `:697-747`): all data slices if present; with exactly one data slice missing and
  a parity shard present, the missing slice is parity XOR the rest (`:729-737`); two missing are not recoverable. Trailing
  `\0` is stripped (`:746`), so a state that ends in `\0` loses it.

### The DHT (item 3)

- `DhtNode.store(key, value, ttl)` (`dht.mjs:421-437`) writes locally and sends `DHT_STORE` to the routing table's closest
  contacts. `handleMessage` for `DHT_STORE` (`:465-473`) stores `msg.value` under `msg.key` with `msg.ttl` for **any sender and any
  key**, replacing what is there, with no size, count or rate bound; it always replies `{ stored: true }`. `fromId` is whatever
  the caller's transport says (the DHT does no authentication of its own). `findValue` / `get` return the value after a TTL
  check (`:402-413`, `:485-492`); `ttl` 0 never expires. There is no iterative lookup and no republish (`docs/security.md`
  "Discovery and StealthAgent").
- `DhtDiscoveryStrategy.announce` (`:850-855`) stores the announced record under `record.podId`, unsigned.
  `browsermesh-apps`' `mesh_dht_store` tool (`tools.mjs:395-410`) stores arbitrary keys.
- Unknown message fields are ignored by `handleMessage` (it reads `type`, `key`, `value`, `ttl`, `targetId`).

### Share release (item 4)

`stealth-threshold.md` reserves the protocol-channel name `stealth:<agentId>:share:release` and says the signed share is the
message it would carry. Nothing implements it. Today the dealer hands each holder its share once (`dealStealthShares`), and a
reader needs `t` of them in hand to call `reconstructStealthSecret`; `minEpoch` and `holders` are the reader's own arguments
(`verifyStealthShare`, `stealth-threshold.mjs`).

## Cross-cutting rule: how an older peer is never sent something it would mis-verify

There is no handshake between a shard writer and the peers that will later read; the DHT is a mailbox. So negotiation is by
**address**: a new record shape is stored at a **new key namespace** that older peers never read, never at a key they read. A new
reader reads both namespaces. A writer chooses what to write, and may write both ("compat"). For DHT stores (item 3) the
addition is an **optional message field** older nodes ignore, with the node's policy advertised in its ping reply. For the
release round (item 4) it is a **new channel name and message type with its own `v`**. In all four, absent the new option,
the bytes on the wire are the old bytes.

## Item 1: a real checksum

### Options

| Option | For | Against |
| --- | --- | --- |
| Keep the char-code sum | nothing to change | collides on any reordering or equal-sum edit; 32 bits; not a hash of the bytes; on the signed path it is never even recomputed |
| CRC-32 | cheap, standard | 32 bits; still weak against structured damage; a second non-cryptographic scheme |
| SHA-256 truncated to 16 bytes | standard, available everywhere here (WebCrypto), 128 bits | the signature would have to cover data separately (a 128-bit digest is a thin binding for a signature) |
| **SHA-256, all 32 bytes** | standard; one value serves as the corruption check **and** as the digest the signature binds | 43 base64url characters per shard record |

### Choice

`checksum = "s256." + base64url(SHA-256(frame(domain, index, threshold, total, code, len, bytes)))`: the whole digest,
domain-separated (`browsermesh-stealth/shard-checksum/3`), length-prefixed (the framing of `stealth-threshold.mjs`), over the
shard's **decoded bytes** and its place (index, the reader's threshold and total, the parity code, the state byte length).
It deliberately does **not** include the agent id: an anonymous record (`lookupNonce`) stores no agent id, and a hash that
could be tested against guessed agent ids would undo that.

Does the signature already cover integrity? Yes, for a signed shard: today through `SHA-256(data)` in the signed text. So what is
the checksum still for?

1. **Unsigned shards**: the plain `hide()` path (and `allowUnsigned` reads of older writers' shards) has nothing else; the
   char-code sum is its only integrity check and it is weak. The new checksum is a real corruption check there. It is not
   authentication: anyone can recompute it. It says "these bytes were not damaged", not "the owner wrote them".
2. **A cheap pre-check, and a diagnosis, on the signed path**: the reader recomputes the checksum first (one hash) and only then
   verifies the signature. A mismatch is counted as `shardCorrupt` (damage, or a record that is not what its checksum says),
   a signature failure as `shardBadSignature` (not from a signer the reader trusts): corruption and forgery are told apart in the
   counters, and an Ed25519 verification is not spent on a record whose bytes are already wrong.
3. On the signed path the signature covers the checksum **instead of** a separate `SHA-256(data)` (the whole digest is in the
   record and the reader recomputes it before trusting it), so the record gains no redundant field.

### Interoperation

Format 3 (also item 2's) uses the key namespace `stealth:<agentId>:shard3:<i>` (plain) or
`hex(SHA-256("browsermesh-stealth/lookup/3\0agent\0nonce\0i"))` (anonymous), never the format-2 keys.

| Pair | What happens |
| --- | --- |
| new writer, default (`shardFormat: 2`) -> old reader | byte-identical to today |
| new writer, `shardFormat: [2, 3]` (compat) -> old reader | the old reader finds the format-2 records it always reads, valid under its rules; the format-3 records sit at keys it never reads |
| new writer, `shardFormat: 3` -> old reader | the old reader finds nothing (`unavailable`). A choice the operator makes once every reader is upgraded; documented, never the default |
| old writer -> new reader (reads `[2, 3]` by default) | format-2 records are read under exactly the old rules |
| mixed swarm, one agent | the reader takes the newest `seq` with a complete valid set across both namespaces; ties prefer format 3 |
| rollback | stale format-2 records left behind by a writer that moved to format 3 are still valid old records; a reader that no longer wants them sets `readFormats: [3]`. Not defended by default: documented |

## Item 2: parity for shards

### What it protects against

Lost shards (a holder gone, a TTL lapsed, an overwrite refused). **Not** forged ones: authenticity is the signature, and a forged
shard is refused before the decoder sees it. It does not make the state secret (that is sealing) and it is unrelated to the key
shares: Shamir shares split `K` so `t` holders are needed to read; parity splits the *state* so any `k` of `k + m` shards are
enough to rebuild it. A reader needs both, for different reasons.

### Options

| Option | For | Against |
| --- | --- | --- |
| today's XOR | no code | every parity shard is the same, so one loss only (the module header says so) |
| **Reed-Solomon (erasure), systematic, over GF(2^8)** | any `k` of `k + m` shards rebuild the state; the data shards stay the plain slices | needs field arithmetic |
| fountain / LDPC codes | rateless | probabilistic decode, more code, nothing to gain at 5 shards |
| a library | audited code | none fits (below) |

### Choice: a small implementation, with vectors

Systematic Reed-Solomon erasure code over GF(2^8), reduction polynomial 0x11d (x^8+x^4+x^3+x^2+1, the field of QR codes,
ISO/IEC 18004, generator 2), with a **Cauchy** parity matrix: `k` data shards `d_0..d_{k-1}`, `m = total - threshold` parity
shards; parity `r` is `sum_c inv(x_r XOR y_c) * d_c` with `y_c = c` and `x_r = k + r` (all distinct, so `k + m <= 256`; the
package caps `total` at 64 and says `too-many-shards` beyond). Every square submatrix of a Cauchy matrix is invertible, so any
`k` surviving shards decode, with no special-casing. Decoding inverts the `k x k` submatrix by Gauss-Jordan over the field.

*Library versus hand-rolled.* #357 took `shamir-secret-sharing` rather than write field arithmetic, because it was audited and
small. The same standard applied here found no fit (checked 2026-11-25 against the registry): `@ronomon/reed-solomon` is a
native addon (not loadable in a browser, last release 2022), `@subspace/reed-solomon-erasure.wasm` and `reed-solomon-erasure`
are wasm builds of a Rust crate last published in 2022 with `@types/node` pulled in, `reedsolomon` is a ZXing port of the
*error-correcting* code (a different thing) and `reed-solomon` is deprecated. None is maintained, none is audited, and a native or
wasm dependency in a package that runs in pages and workers is a heavier burden than the 90 lines of arithmetic. `shamir-secret-
sharing` does not export its field. So: a small implementation (`packages/browsermesh-discovery/src/shard-parity.mjs`), **no new
dependency**, validated by (a) the GF(2^8) 0x11d antilog/log table checked against the published ISO/IEC 18004 values, (b) the
MDS property checked exhaustively (every subset of `k` of `k + m` shards decodes, for several `(k, m)`), and (c) a second,
independent implementation in the test (carry-less shift-and-xor multiplication, parity rows built from the definition above,
decoding by a different elimination order) that must produce byte-identical parity. There is no published byte vector for
*this exact* Cauchy construction (the widely published ones use Vandermonde matrices): the report says so; (a) is the published
part.

### Representation (format 3)

The state is encoded to UTF-8 (a string with a lone surrogate is refused, `not-well-formed`), cut into `k` byte chunks of
`ceil(len / k)`, the last zero-padded; the record carries `len`, so the NUL-stripping flaw of `:746` does not exist in format 3.
`data` is base64url of the bytes (JSON-clean; 4/3 of the byte size). Record, signed and anonymous:
`{ v: 3, i, data, checksum, code, len, seq, sig }`; plain adds `shardId, agentId, threshold, total`. `code` is `"rs"` (default
in format 3) or `"xor"` (the old parity under the new checksum, for item 1 alone). The signed text is
`browsermesh-stealth-shard/3`, agent, key, index, seq, threshold, total, `checksum`, nonce. `code` and `len` are not listed
separately: the checksum already commits to them (and to the bytes, index, threshold and total), so signing the checksum signs
them, and a record re-labelled to make the decoder produce a different state fails the checksum (damage) or, with a recomputed
(public, unkeyed) checksum, the signature. The tests pin both.

Overhead: `(k + m) / k` times the state, times 4/3 for base64url. The defaults `3 of 5` give 1.67x (2.2x encoded) and survive
**two** lost shards of any kind, where XOR survived one data shard. Interop: as item 1 (same format-3 namespace; a reader decodes
each record by its own `code`).

## Item 3: who may store under which key

### What a node accepts today

See "The DHT" above. The consequences: anyone who can send a `store` can replace a record (a signed shard is then refused by the
reader, so the loss is availability, never a wrong state; counted as `shardBadSignature`); fill a node (no cap); keep an entry
for ever (`ttl` 0); and replace another peer's announcement.

### Options

| Option | For | Against |
| --- | --- | --- |
| a key derived from the writer's public key (`key = H(pub)`, as mutable-item DHTs do) | no state kept to enforce; ownership is arithmetic | the stealth keys are `H(agentId, nonce, i)` on purpose (#329): readers compute them from a secret, not from a public key; making them `H(pub)` breaks readers that hold only the nonce |
| a signature over `(key, value, seq, expiry)` checked by every storing node, ownership pinned to the first valid signer | works for any key, including the anonymous ones | first writer wins: needs a rule against squatting |
| per-record-type rules (what a key *looks like* decides what is required) | the `stealth:` / podId / 64-hex namespaces are already distinguishable | more code |
| quotas per writer and per storing node, a lifetime cap | bounds what any writer can spend | needs a clock and counters |
| **a combination** | below | |

### Choice

**Authorization is a signed store, message-level.** `DHT_STORE` may carry `auth: { v: 1, w, seq, exp, sig }`: `w` the
writer's raw Ed25519 public key, `seq` a per-key counter, `exp` an absolute expiry (ms since the epoch), `sig` over
`frame("browsermesh-dht-store/1", key, SHA-256(canonical JSON of value), seq, exp)`. The stored **value is unchanged**: readers of
`findValue` get what they always got; the proof lives in the entry's metadata at the storing node and travels with replication.
Canonical JSON is key-sorted and rejects what JSON cannot carry.

**Which key a writer may own** (`classify(key)` -> kind):

| Key kind | How it is recognised | Binding |
| --- | --- | --- |
| pod key | 43 base64url characters (the shape of a pod id); owned by `podId(w)` (base64url SHA-256 of `w`) | strict: only the holder of that pod's private key can store; no first-writer race. A proof for such a key from any other writer is refused `not-key-owner` |
| stealth key, agent named | `stealth:<id>:shard3:<n>`; if `id` has the shape of a pod id it must equal `podId(w)` (else `not-key-owner`) | strict, as above; if `id` is some other string the key is `pinned` |
| stealth key, anonymous | 64 lowercase hex characters | `pinned` |
| anything else | | `open` in `open` mode (a proof is verified, nothing is owned); `pinned` in `owned` mode |

*Strict*: an authenticated store is accepted only from the pod the key names. *Pinned*: the first valid authenticated store to a
node pins `w` to the key until its `exp`; later stores must carry the same `w` and a higher `seq`. *Open*: as today.

*Asynchronous answers.* Checking a proof is an Ed25519 verification, which is asynchronous in WebCrypto, so a node **with a
policy** answers a store with a promise (`handleMessage`) and `store()` returns a promise of `{ stored }` or `{ stored: false,
refused }`; a node **without** a policy is byte-for-byte and call-for-call what it was (`handleMessage` synchronous; `store()` now
returns `{ stored: true }` where it returned nothing). `browsermesh-apps`' `mesh-dht` ignores the reply, so it works unchanged
with a policy node.

**Reconciling with anonymous keys (#329).** The writer key for an anonymous record is **per record and secret**: `w_i` is the
Ed25519 key whose seed is `SHA-256("browsermesh-dht/write-key/1" || sign_identity(domain || lookupNonce || i))`. An Ed25519
signature is deterministic and only the agent's identity can produce it, so (a) the agent re-derives `w_i` on demand and stores
nothing, (b) nobody who merely holds the nonce (the group members who read the shards) can write under the key, (c) an observer
who sees `w_i` learns nothing linking it to the agent or to the other shards (each `w_i` is pseudorandom, unrelated to the identity
key and to each other), so the unlinkability of the keys is unchanged. The writer checks at start that the identity signs
deterministically (two signatures of the same bytes are equal) and refuses to enable owned stores otherwise
(`identity-not-deterministic`), because a randomized signer would derive a different key each time.
The legitimate writers today are exactly the agent's own identity; group members read (they compute the key from the nonce) and
do not write. A second replica of the agent that signs with a different identity owns different `w_i` and must use its own nonce
(its shards are still readable through `trustedKeys`); this is stated, not hidden.

**Node policy** (`DhtNode` option `storePolicy`, default `{ mode: 'open' }`):

- `open` (default): a store without `auth` behaves exactly as today (accepted), **except** that it cannot replace an entry that is
  currently owned (strict, or pinned) (`owned-key`). A store with `auth` is verified (`bad-auth` if not) and, for strict and pinned
  *new-namespace* keys (`shard3`, anonymous 64-hex), takes ownership. Legacy keys (`stealth:<id>:shard:<i>`, plain podId keys
  written unsigned) are never pinned in `open` mode, so a first-writer race cannot be turned into a new way to lock an old
  writer out.
- `owned`: every store must carry valid `auth` and the key must be strict or pinned (`unsigned-store`, `unbound-key`); apps list
  `openPrefixes` they keep open.
- Limits (defaults unlimited in `open`, bounded in `owned`: 64 KiB value, 4096 entries, 256 per writer, 7 days of lifetime, 120
  stores/min per sending peer; the `StealthAgent` writer's own default proof lifetime is 24 h): `value-too-large`, `store-full`, `writer-quota`, `lifetime-too-long`, `rate-limited`, `expired`
  (an `exp` in the past, or a record whose `exp` has passed; a stored entry never outlives `exp`). Expired entries are purged when
  the node needs room.
- A refused store replies `{ stored: false, refused: "<name>" }`. Counters per name are exposed (`stats`); log lines carry the
  refusal name and the first 8 hex characters of `SHA-256(key)`, never the value.
- Republish: a writer re-stores with a higher `seq` before `exp`; the node replaces on higher `seq` only (`stale-seq`).

**What a storing node does with a store from an older writer that carries no proof**: `open` accepts it (unless the key is
owned); `owned` refuses it with `unsigned-store`. Operators choose; the default never changes what an old writer can do.

### Interoperation

| Pair | What happens |
| --- | --- |
| new writer (sends `auth`) -> old node | the old node ignores `auth`, stores the value as before; no protection there, nothing breaks |
| old writer (no `auth`) -> new node, `open` | accepted as today, unless it targets an owned key (refused `owned-key`, the old writer sees `stored: false` where it always saw `true`: it ignores the field) |
| old writer -> new node, `owned` | refused `unsigned-store` for keys the node requires owned; the operator opted in |
| new writer -> new node | verified; replicas verify independently because `auth` is replicated with the value |
| mixed swarm | protection holds only on the new nodes that store a key; a reader's own signature check (`StealthAgent`) still protects it from values served by an old node. A new node's `DHT_PING` reply carries `caps: { store: 1, policy }`; an old node's has none, which a writer reads as "legacy" |
| key namespace | the owned kinds live only in the new (`shard3`, 64-hex) namespaces for stealth, so no legacy record is ever re-keyed |

## Item 4: the on-demand share release round

### Shape

A reader (a group member who needs `K` and holds fewer than `t` shares) sends a **release request** to each holder over
a protocol channel named `stealth:<agentId>:share:release` (the reserved name; the transport is the caller's, the module is
`handle(fromPodId, request) -> response` and `requestShareRelease({ holders, send })`). Each holder answers with its signed share
(`stealth-threshold.md`), **sealed to the requester**, or with a named refusal. The reader feeds what it gets to
`reconstructStealthSecret` exactly as for shares delivered up front; `minEpoch` and `holders` carry through unchanged.

### Request (`v: 1`)

`{ v, type: "release", tag, holder, requester, eph, iat, nonce, minEpoch, sig }`:

- `requester`: the asker's raw Ed25519 public key; `sig` is over `frame("browsermesh-stealth-release/1", ...every other field)` so the
  request is bound to **this holder** (`holder`), a time (`iat`) and a nonce.
- `tag = hex(SHA-256("browsermesh-stealth-release/tag/1", groupId, agentId))`: the agent and group are named by a tag, so
  the message does not carry the agent id or group id in the clear, and it is sent **only to the holders** (a point-to-point
  channel message, never a broadcast). A holder maps tags to the shares it holds.
- `eph`: an ephemeral X25519 public key; the holder derives (ECDH, HKDF-SHA-256 with the request id as info) a key and seals the
  share with AES-256-GCM, so the share is confidential even on a channel that is not.

### What a holder checks, in this order (a cheaper check first, a refusal that reveals least first)

1. size and shape (`malformed`, `too-large`); `v` known (`unsupported-version`, replying with its own maximum `v`)
2. `holder` is this holder; `iat` within the freshness window (default 60 s each way: `stale-request`)
3. rate limit per requester key and a global concurrent cap (`rate-limited`), **before any signature work**
4. signature valid (`bad-signature`); nonce not seen in the window (`replayed`; bounded cache, oldest dropped)
5. **membership**: `requester` is in the holder's current roster of members (`not-a-member`). The proof is the signature of a key the
   holder already lists; the group secret is not needed, so nothing is revealed to prove membership. A leaving member is removed
   from the roster, so the epoch rules and the roster agree
6. only now the tag: unknown tag -> `no-share`. A non-member never reaches this step, so it learns nothing about which agents
   a holder serves
7. the share's `epoch >= max(request.minEpoch, holder.minEpoch)` (`stale-epoch`) and the holder's own name is in the share
   (`unknown-holder`): the same rules as `verifyStealthShare`
8. an optional `approve({ requester, agentId, groupId, epoch })` callback (consent, quorum, a human); `not-approved` unless it returns `true`
9. release (sealed); log the outcome

A holder never logs a share, a key or the tag in full: it logs `{ outcome, reason, requester podId, first 8 hex of the tag, epoch }`
through a caller-supplied `log`. The response is signed by the holder (`sig` over request id, holder, sealed bytes) so a reader
knows which holder answered; the share inside is still verified against the dealer as always.

### Reader side, and what an offline holder means

The reader sends to all holders in parallel with a timeout and a cap on holders (255, the share limit). It stops as soon as `t`
distinct valid shares of one epoch are in. A holder that does not answer is `unreachable`; one that refuses is `refused` with its
reason. If fewer than `t` shares arrive it throws `below-threshold` with those counts and returns nothing: availability needs
`n - offline >= t`, exactly as for shares delivered up front; offline holders do not weaken secrecy and do not lower `t`. Freshness
and replay of the **response** are covered by the request id in the key derivation and the AES-GCM associated data.

### Interoperation

The channel name and the message `type`/`v` are new; an older peer never opens that channel, so it neither answers nor mis-parses
(the asker sees `unreachable` and counts it against the threshold). A holder that receives a higher `v` replies `unsupported-
version` with the highest it speaks. Shares themselves are unchanged (`v: 1`), so an old dealer's shares can be released by a new
holder, and a new reader can recombine shares an old holder gave up front.

## Threats

In the style of `docs/security.md`: the scenario, and what the code does. Nothing here is a recipe; each row is behaviour the tests pin.

| Scenario | Behaviour |
| --- | --- |
| a shard record is damaged in storage | the checksum no longer matches: the record is refused and counted as `shardCorrupt`; with parity enough other shards rebuild the state |
| a record is replaced by one with a valid-looking checksum but another signer | refused, `shardBadSignature`; the checksum is not authentication |
| two or more shards are lost | with `k` left the state is rebuilt (RS); with XOR it is not |
| a peer stores under a key owned by another pod | refused `owned-key` / `bad-auth`; the existing entry is unchanged |
| a store with a valid proof but for a key the writer does not own | an unbound proof does not take ownership; in `owned` mode refused `unbound-key` |
| an oversized, expired or too-long-lived record | refused `value-too-large` / `expired` / `lifetime-too-long`; no partial write |
| a flood of stores from one peer or for one writer | `rate-limited` / `writer-quota` / `store-full`; the node's other entries stay |
| a captured store message sent again later | refused `stale-seq` while the entry lives, `expired` after `exp` |
| an unsigned store from an older writer | `open`: accepted as before; `owned`: `unsigned-store` |
| a release request from someone who is not a member | `not-a-member`, before the tag is read; nothing about held shares is revealed |
| a captured release request sent again, or to another holder | `replayed` / bound to the holder (`bad-signature`) |
| a stale request | `stale-request` |
| a share altered in a response | the dealer signature fails in `reconstructStealthSecret`: refused and counted |
| a release response read on the channel | sealed to the requester's ephemeral key; the share is not readable |
| a holder that was removed from the group | its share is refused through `holders` and `minEpoch`, as in #357 |
| a holder offline | counted `unreachable`; success needs `t` of the others |

## What is deliberately not defended

- **Authenticity of the sender at the DHT**: `fromId` is the transport's claim; rate limits and quotas per peer are only as good as that.
- **A first-write race on a pinned key**: a peer that sees a store message in transit to one node can claim that key at *another*
  node before the owner's message gets there. Strict keys (pod ids) have no such race; anonymous keys are secret until first stored.
- **Replay after early eviction**: a captured store is refused while the entry lives (`stale-seq`) and after its `exp`; if the entry
  was evicted earlier (for example to make room) the same captured message can be applied again until `exp`. The node keeps no
  tombstones.
- **Availability against overwrite**: refusing an overwrite protects the entry on the nodes that enforce; a node that does not
  (older, or `open` for legacy keys) can still be filled with garbage; readers still verify what they read.
- **Parity does not hide or authenticate** anything; **rollback** to an older complete set while stale records remain in the other
  namespace (use `readFormats: [3]` once all writers are upgraded).
- **Guessable agent ids**: the release tag is a hash of the group id and agent id; a requester-side observer who can guess both can
  confirm a guess. The tag only keeps names off the wire.
- **A member who is already a member** can ask every holder (membership is the proof); `approve` is where an application adds more.
- **Colluding holders, a compromised dealer, traffic analysis**: unchanged from `stealth-threshold.md`.
- **Deterministic-signature assumption** for anonymous owned stores (`identity-not-deterministic` is refused, not worked around).

## Staged order and independence

1. **Items 1 and 2 together**: the checksum and the parity share the one new record format and key namespace (format 3), so they
   are one pull request. Independent of the others.
2. **Item 3**: the DHT enforcement is independent of 1, 2 and 4 in `dht.mjs` and a new `dht-auth.mjs`; the `StealthAgent` writer
   that signs its stores for the new namespaces needs format 3, so that last step builds on item 1+2.
3. **Item 4**: independent of all of them (a new module over the existing threshold module).

Status (updated as each lands): items 1 and 2: **built** (shard format 3, opt-in); item 3: **built** (`storePolicy`, `StealthAgent` `ownedStores`, opt-in); item 4: **built** (`stealth-release.mjs`, opt-in).
