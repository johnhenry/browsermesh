# browsermesh-discovery

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-discovery.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-discovery)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-discovery.svg)](LICENSE)

DHT, peer discovery, naming, swarm coordination, and stealth networking for BrowserMesh.

## Why this exists

Identity (`browsermesh-primitives`/`browsermesh-core`) answers "who is this peer," but a mesh also needs to answer "which peers exist, and how do I find one I haven't talked to yet." That's a genuinely different problem -- Kademlia-style routing tables, gossip, service directories, name resolution, swarm membership/leader-election -- and bundling it into `browsermesh-core` would force every identity-only consumer to pull in DHT/swarm machinery it doesn't need. `browsermesh-discovery` exists as that separate layer: `DhtNode`/`RoutingTable`/`GossipProtocol` for peer-to-peer lookup, `DiscoveryManager`/`DiscoveryStrategy` for pluggable discovery mechanisms (including DHT-backed bootstrap), `MeshNameResolver` for human-readable naming, and `SwarmCoordinator`/`SwimMembership` for group membership and coordination. It depends only on `browsermesh-primitives`, for the shared `MESH_TYPE` message-type constants its DHT and swarm messages are tagged with.

## Used by

`@johnhenry/browsermesh-apps` treats this package as an optional peer: `mesh-bootstrap.mjs` lazily `import()`s it to wire a real DHT-backed discovery strategy into `createMeshNode()` (`mesh-dht.mjs`), and `serverless-fetch.mjs`'s `MeshFetchRouter` reuses this package's `parseMeshRequest()` directly to route `mesh://` URLs. Neither is a hard requirement -- `createMeshNode()` works with no discovery strategy at all, or with a caller-supplied one.

## Provenance

Extracted from a private monorepo (previously `packages/browsermesh-discovery`), where it was manually published to npm, unscoped, as `browsermesh-discovery@0.1.0` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.


## Modules

| Module | Key Exports |
|--------|-------------|
| dht | `DhtNode`, `RoutingTable`, `KBucket`, `GossipProtocol` |
| discovery | `DiscoveryManager`, `DiscoveryStrategy`, `ServiceDirectory`, `BroadcastChannelStrategy` |
| naming | `MeshNameResolver`, `NameRecord`, `parseMeshUri` |
| swarm | `SwarmCoordinator`, `LeaderElection`, `TaskDistributor`, `SwimMembership` |
| sw-routing | `MeshFetchRouter`, `parseMeshRequest` |
| stealth | `StealthAgent`, `ShardDistributor`, `ShardCollector` |
| owned stores (opt-in) | `signDhtStore`, `verifyDhtStore`, `deriveWriteSigner`, `canonicalJson`, `classifyStoreKey`, `DHT_STORE_REFUSALS` |
| shard parity (opt-in, format 3) | `rsEncode`, `rsDecode`, `ParityError`, `MAX_RS_SHARDS`, `stealthShardChecksum` |
| share release (opt-in) | `createShareHolder`, `requestShareRelease`, `createReleaseRequest`, `createReleaseResponse`, `stealthReleaseChannel`, `stealthReleaseTag`, `RELEASE_REFUSALS` |
| stealth threshold (opt-in) | `dealStealthShares`, `reconstructStealthSecret`, `verifyStealthShare`, `thresholdEpochKeys`, `stealthEpochKeyId`, `stealthShareSigningBytes` |

## Install

```bash
npm install @johnhenry/browsermesh-discovery @johnhenry/browsermesh-primitives
```

## Usage

```js
import { DhtNode, DiscoveryManager, SwarmCoordinator } from '@johnhenry/browsermesh-discovery';
```

## Swarm membership: `SwimMembership` feeds `SwarmCoordinator`

`SwarmCoordinator` has **no wire of its own**: the `SWARM_*` message types are
unused re-exports, so there is no swarm protocol to speak. Membership comes
from `SwimMembership`, which you run over your own transport (`sendFn` out,
`handleMessage(fromId, msg)` in) and hand to the coordinator:

```js
const swim = new SwimMembership({ localId, sendFn: (to, msg) => send(to, msg) });
const swarm = new SwarmCoordinator(localId, { swim });
swarm.join(seedPodId);   // a seed is enough: SWIM spreads the rest
swim.start();            // you start and stop SWIM; swarm.stop() only unhooks the coordinator
```

What SWIM guarantees:

- **Updates spread along a chain.** Each membership update (join, suspect,
  dead, left) rides up to `ceil(retransmitMultiplier * ceil(log2(n + 1)))`
  messages (SWIM's infection-style dissemination; `n` is the members known
  here), least-transmitted updates first, then is retired. A pod that learns
  an update passes it on, and a pod that hears from a peer it has never met
  learns it. Seeds `a -> b -> c` therefore give `c` a view of `a` within a few
  rounds; you do not have to seed everyone with everyone.
- **The coordinator follows SWIM.** A member that SWIM reports `alive` joins
  the `'local'` swarm; one reported `left` or `dead` is dropped, on every pod
  that hears about it, not only the pod that noticed (`dead` is declared by a
  pod's own silence timeout; `left` is `swarm.leave(podId)` gossiped on). A
  higher-incarnation `alive` brings a member back; an equal-or-lower one does
  not (precedence: higher incarnation wins, then `left` > `dead` > `suspect`
  > `alive`). `SwarmCoordinator` chains any `onJoin`/`onDead`/`onLeave` you set
  on the SWIM instance first, and `swarm.stop()` restores them.
- **Wire format is unchanged.** Updates are still `{ podId, state, incarnation }`
  on `updates` of ping/ack messages, so older peers interoperate; the transmit
  counters are local state and never sent.

Options on `SwimMembership`:

| Option | Default | Meaning |
|---|---|---|
| `retransmitMultiplier` | `3` | SWIM's lambda: an update rides `ceil(lambda * ceil(log2(n + 1)))` messages (about 3 log n), then is retired |
| `maxPiggyback` | `8` | Most updates carried by one message (the message size bound) |
| `maxQueuedUpdates` | `128` | Cap on pending updates; at the cap the most-transmitted entry is dropped |

Membership and leader election are unauthenticated (see `docs/security.md`).
Runnable: `examples/27-dht-and-stealth-records.mjs`, step 4.

## `StealthAgent` is sharding; encryption is opt-in

For secrecy, derive a per-group key and use the async encrypted path:

```js
const key = await deriveStealthKey(groupSecret, 'my-group'); // HKDF-SHA-256 -> AES-256-GCM
const agent = new StealthAgent({ agentId, dhtNode, key });
await agent.hideEncrypted(state);          // shard holders see only ciphertext
const state = await agent.reconstituteEncrypted();
```

The payload is bound to the agent id and a wrong key or any tampering rejects.

For key rotation and replay bounding, give the agent a `StealthKeyring`
instead of a single key:

```js
const keyring = await StealthKeyring.fromGroupSecrets('my-group', [{ id: 'k1', secret: s1 }]);
const agent = new StealthAgent({ agentId, dhtNode, keyring, maxAgeMs: 86_400_000 });
await agent.hideEncrypted(state);        // v2.<keyId>.<seq>.<issuedAt>.<AES-GCM(iv || ciphertext)>
await keyring.add('k2', s2, { makeCurrent: true }); // rotate: new seals use k2, k1 still opens old state
keyring.remove('k1');                    // when nothing sealed under k1 matters any more
const r = await agent.tryReconstituteEncrypted(); // { ok, state } | { ok: false, reason }; counted in agent.stats
```

Each message gets a fresh random 96-bit nonce; a key refuses to seal past
2^32 messages (`key-exhausted`: rotate). The key id, sequence number and issue
time are authenticated together with the sender (agent id) and message type as
associated data. An older state than the newest this agent wrote or accepted
is refused as `replayed`; `maxAgeMs` refuses `stale` state. A peer without the
key (or looking at plaintext state) gets `{ ok: false, reason }` and a counter
in `agent.stats`, not a thrown error.

**What this hides, and from whom.** The content of the state, from nodes that
hold the DHT shards and anyone relaying them. **Not hidden:** that an agent
exists (shard keys name it), the size of its state, when it is written or read,
and who reads it (traffic analysis). Everyone holding the group key can read
the state and can also forge it: the sender in the associated data is a label,
not a signature (signed shards are not built). Group key custody and rotation
when a member leaves are the application's job. Replay protection is best
effort: an agent that has just started and has seen nothing newer cannot tell
an old state from the current one unless `maxAgeMs` is set.

**Signed shards and agent-anonymous keys (opt-in).** Give the agent its
identity and every shard it stores is signed and every shard it reads is
verified:

```js
const agent = new StealthAgent({
  agentId, dhtNode, key,
  identity,                                                  // a PodIdentity: signs and verifies shards
  lookupNonce: await deriveStealthLookupNonce(groupSecret, agentId, 0), // optional: keys that do not name the agent
})
await agent.hideEncrypted(state)           // signed shards (also hideSigned(): signed, plaintext slices)
const r = await agent.tryReconstituteEncrypted() // { ok, state } | { ok: false, reason }
agent.stats // shardBadSignature, shardUnsigned, shardStale, ... (refused and counted)
```

A signature covers the agent, the key the shard lives under, its index, the
write's sequence number, its content and the lookup nonce, so a changed shard,
one moved to another key, one signed by someone else, or an old write mixed
into a new one is refused and counted; the newest complete write wins. A shard
with **no** signature (written by an older peer) is refused too unless you pass
`allowUnsigned: true`. Only keys you name can sign: the agent's own, plus any
raw public keys in `trustedKeys`. An agent with an `identity` cannot call the
synchronous `hide()` / `reconstitute()` / `isViable()` (they throw
`async-required`; use `hideSigned()`, `reconstituteSigned()`, `isRecoverable()`),
so it never writes or reads unsigned by accident; agents without an `identity`
are unchanged.

With a `lookupNonce` the DHT keys are `hex(SHA-256("browsermesh-stealth/lookup/1"
NUL agentId NUL nonce NUL index))` and the records hold no agent id, shard id or
public key: someone watching the DHT who does not know the nonce cannot link a
key to the agent, or one agent's shards to each other, by key. They can still see
that records exist, their sizes and timing and the fields one write shares
(sequence number, checksum), so a determined observer can group them. Everyone who
should be able to find the shards must hold the nonce:
`deriveStealthLookupNonce(groupSecret, agentId, epoch)` derives it from the group
secret (HKDF-SHA-256), so every member computes the same one with nothing extra
stored, and a new `epoch` moves the shards to new keys when membership changes;
or keep a random one with the agent's other custodial keys. The data inside is
plaintext unless you use the encrypted methods. By default the DHT still accepts a `store` from anyone,
so an overwrite makes a shard unusable (refused) rather than accepted; see "Who may store under which key" below to change that.

**Threshold sharing of the group secret** is opt-in and separate from `StealthAgent`
(nothing on the existing wire changes). The agent's owner pod deals a fresh 32-byte secret
`t`-of-`n` (Shamir over GF(2^8), the audited `shamir-secret-sharing`, loaded on first use),
signs every share, and holders recombine it from any `t` valid shares:

```js
const dealt = await dealStealthShares({ identity: ownerIdentity, agentId, groupId: 'ops', epoch: 0, holders: memberPodIds }); // t defaults to a majority
// hand dealt.shares[i].share to memberPodIds[i] over a confidential, authenticated channel
const { secret, epoch } = await reconstructStealthSecret(sharesFromAnyTHolders, { trustedDealers: [ownerPublicKey], agentId, groupId: 'ops', minEpoch: 0, holders: memberPodIds });
const { lookupNonce } = await thresholdEpochKeys(secret, { agentId, groupId: 'ops', epoch, keyring });
const agent = new StealthAgent({ agentId, dhtNode, keyring, lookupNonce, identity });
```

Fewer than `t` shares reveal nothing; a share that was altered, relabelled or dealt by a dealer you do not
name is refused and counted; shares of different epochs are never mixed. When a member leaves, deal `epoch + 1` to
the rest, re-seal the latest state and pass `minEpoch`. A compromised dealer, `t` colluding holders, and what a leaving
member already read are NOT protected, and shares are signed, not encrypted: see
[docs/design/stealth-threshold.md](https://github.com/johnhenry/browsermesh/blob/main/docs/design/stealth-threshold.md).

**On-demand share release** (opt-in; [design note](https://github.com/johnhenry/browsermesh/blob/main/docs/design/discovery-records.md), item 4).
Instead of only holding shares dealt up front, a group member can ask the holders when it needs the secret. Each holder checks
who is asking before it says anything about what it holds, and answers with its signed share sealed to the requester:

```js
// holder side: one per share holder, over the protocol channel stealthReleaseChannel(agentId) = `stealth:<agentId>:share:release`
const holder = createShareHolder({ name: myPodId, identity, members: memberPublicKeys, trustedDealers: [dealerPublicKey], approve, log });
await holder.addShare(myDealtShare);
channel.onMessage((from, request) => channel.reply(from, holder.handle(from, request)));
// reader side: a member
const { secret, epoch, released, refused, unreachable } = await requestShareRelease({
  identity, agentId, groupId, trustedDealers: [dealerPublicKey], minEpoch, holders: currentHolderNames,
  peers: holders.map((h) => ({ holder: h.name, publicKey: h.publicKey, send: (request) => channel.request(h.podId, request) })),
});
```

The request is signed by the member, bound to one holder, a time and a nonce, and names the agent only by a hash. A holder
refuses by name (`not-a-member`, `replayed`, `stale-request`, `rate-limited`, `stale-epoch`, `no-share`, `not-approved`, ...)
and a non-member gets the same answer whether or not the holder holds that agent. With fewer than `t` valid shares the reader
throws `below-threshold` with who was refused or unreachable; an older peer that does not run the channel is simply
unreachable. `holder.retire({ agentId, groupId, belowEpoch })` drops old shares and `holder.setMembers(keys)` follows the roster.

**Shard format 3: a SHA-256 checksum and Reed-Solomon parity** (opt-in, `shardFormat: 3` or `[2, 3]`;
[docs/design/discovery-records.md](https://github.com/johnhenry/browsermesh/blob/main/docs/design/discovery-records.md)).
Format 3 shards are base64url byte slices of the UTF-8 state with `total - threshold` Reed-Solomon parity shards
(GF(2^8), polynomial 0x11d, Cauchy matrix; `parity: 'xor'` keeps the old single-loss parity), so **any `threshold` of
`totalShards` valid shards rebuild the state** (with the defaults 3 of 5, any two lost, data shards included). The
checksum is the whole SHA-256 over the shard's bytes, index, threshold, total, parity code and state length: on the
unsigned path a real corruption check (not authentication: it is unkeyed), on the signed path a cheap check before the
signature that tells damage (`stats.shardCorrupt`) from forgery (`shardBadSignature`). Parity protects against lost
shards, not forged ones, and is unrelated to the Shamir key shares above (those split the secret, this splits the
state). Format 3 records live under **different DHT keys** (`stealth:<agentId>:shard3:<i>`, or the `lookup/3` label), so an
older peer never reads one and cannot mis-verify it: `shardFormat: [2, 3]` writes both so older readers keep working,
`shardFormat: 3` alone is for when every reader is upgraded; readers read both by default (`readFormats`). The
synchronous `hide()` stays format 2 (it throws `async-required` if `shardFormat` includes 3; use `hideAsync()`).

**Who may store under which key** (opt-in; [design note](https://github.com/johnhenry/browsermesh/blob/main/docs/design/discovery-records.md), item 3).
By default a `DhtNode` accepts a `store` from anyone for any key, as it always did. Give it a `storePolicy` and a store may carry
a proof (`signDhtStore`: the writer's key, a `seq`, an absolute expiry and an Ed25519 signature over key, value, `seq` and expiry):

```js
const node = new DhtNode({ localId, sendFn, storePolicy: { mode: 'open' } }); // or 'owned': every store needs a proof
const auth = await signDhtStore({ signer: identity, key: identity.podId, value: record, seq: 1, exp: Date.now() + 3_600_000 });
await node.store(identity.podId, record, 0, { auth }); // replicated with the proof; older nodes ignore it
node.storeStats; // { accepted, refused: { 'owned-key': 1, 'rate-limited': 3, ... } }
```

A pod-id-shaped key can be stored only by that pod; an owned key is replaced only by its owner with a higher `seq`; sizes,
entry counts, per-writer quotas, proof lifetimes and per-peer rates are bounded (`owned` mode defaults, or set
`maxValueBytes`, `maxEntries`, `maxEntriesPerWriter`, `maxLifetimeMs`, `rate`) and every refusal is named and counted. With a
policy, `handleMessage` for a store and `store()` return promises. `new StealthAgent({ identity, lookupNonce, shardFormat: 3,
ownedStores: true })` signs its shard stores with a per-shard writer key derived from the identity: the anonymous keys do not
change and are not linked by it, group members who hold the nonce can read but cannot store under them.

`DhtDiscoveryStrategy` takes the same `storePolicy` for its node, and (opt-in) `signStore: async (key, record) => auth`, called by
`announce` for the record it stores: return a proof to store with it, or nothing to store unsigned as before. A signer that throws
stores nothing and `onStoreRefused({ key, refused })` is told (`sign-failed`, or the node's own refusal); `announce` never throws for
a refusal. `strategy.storePolicy` and `dhtNode.storePolicy` report what is in force (`null` when there is none). `browsermesh-apps`'
`createMeshNode({ enableDht, dhtSignStores, dhtStorePolicy })` uses these.

The plain `hide()` / `reconstitute()` below are unchanged and plaintext:

`StealthAgent.hide(stateString)` / `reconstitute()` split a state string into
`threshold` plaintext data shards plus XOR parity shards and store them in the
DHT under `stealth:<agentId>:shard:<i>`. It improves availability, not secrecy:

- the shards contain the state verbatim (data shards) or its XOR (parity);
  anyone who can read the DHT entries can read the state;
- every parity shard is the same XOR of all data chunks, so the state survives
  the loss of **one** data shard, not `total - threshold` of them;
- the checksum detects accidental corruption only, not tampering;
- the keys name the agent they hold state for.

If the state is sensitive, encrypt it before `hide()` and decrypt after
`reconstitute()`; this package does not manage keys.

## License

MIT
