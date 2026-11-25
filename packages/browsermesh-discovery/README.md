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
| stealth threshold (opt-in) | `dealStealthShares`, `reconstructStealthSecret`, `verifyStealthShare`, `thresholdEpochKeys`, `stealthEpochKeyId`, `stealthShareSigningBytes` |

## Install

```bash
npm install @johnhenry/browsermesh-discovery @johnhenry/browsermesh-primitives
```

## Usage

```js
import { DhtNode, DiscoveryManager, SwarmCoordinator } from '@johnhenry/browsermesh-discovery';
```

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
plaintext unless you use the encrypted methods. The DHT still accepts a `store` from anyone,
so an overwrite makes a shard unusable (refused) rather than accepted.

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
Also not done: a real checksum and multi-loss parity. The plain
`hide()` / `reconstitute()` below are unchanged and plaintext:

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
