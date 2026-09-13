# How to build a mesh-native service

`CloudStorage` (`src/cloud-storage.mjs`) is the first mesh-native service
built in this repo end to end — an S3-like object store with **no server
anywhere**: every byte lives in each participating peer's own local storage,
replicated peer-to-peer. Building it (phases A–H of the CloudStorage plan,
`johnhenry/browsermesh` PRs #79–#100) surfaced a small set of reusable
patterns worth documenting once so the *next* mesh-native service — a
pub/sub queue, a KV cache, a job board, whatever it turns out to be — starts
from precedent instead of re-deriving these same design questions from
scratch. This guide is that writeup. It is not a tutorial in the sense of
"copy these files" — it's a map of the decisions, with pointers to the real,
merged code that made each one, and to `examples/09-cloud-storage.mjs` /
`test/real-peer/cloud-storage.test.mjs` as the worked, runnable proof.

There is no `Service` base class to extend. Every pattern below is a
convention — a shape your code follows — not an inheritance hierarchy to
plug into. That is itself the first, and maybe most important, lesson this
phase produced (see "`MeshService` is a minimal attach contract" below).

## 1. `MeshService`: the attach contract

Before this pattern existed, `mesh-sync.mjs` (`MeshSyncBinding`) and
`mesh-relay-host.mjs` (`MeshRelayHost`) each hand-rolled the identical
plumbing: subscribe to `PeerNode.onIncomingData()`, filter incoming messages
by an `envelope.type` string, reply via `node.sendTo()`. `mesh-service.mjs`
generalizes that plumbing into one small, reusable convention rather than
letting every future service reinvent it a third, fourth, fifth time.

A `MeshService` is a **plain object descriptor**, not a class to
instantiate:

```js
{
  name: 'my-service:some-id',       // unique; keys createMeshNode({services})'s node.services map
  attach(peerNode, ctx) { ... },    // wire the service; return a teardown fn or {teardown, api}
  createBackend(ctx) { ... },       // OPTIONAL -- only if this service also wants a netway Backend
  backendScheme: 'my-scheme',       // only consulted if createBackend is present
}
```

`attachService(peerNode, network, descriptor)` is the composition-root
function that builds a `ctx` for the descriptor, calls `descriptor.attach()`,
and (only if `createBackend` is present) registers the returned `Backend`
onto `network`. `ctx` gives a service everything it needs without ever
touching `PeerNode` internals directly:

- `ctx.onIncomingData(types, callback)` — envelope-type-filtered
  subscription. `callback(pubKey, envelope)` only fires for envelopes whose
  `.type` matches `types` (string or array). Returns an unsubscribe function.
- `ctx.sendTo(pubKey, type, payload)` — sends `{ type, ...payload }` via
  `peerNode.sendTo()`.
- `ctx.registry` — the node's `PeerRegistry`, for `checkAccess()`.
- `ctx.peerNode` / `ctx.network` — escape hatches for anything not covered
  above.

**This is a minimal attach contract, not a `Backend` factory.** An earlier
framing of this design required every mesh-native service to produce a
netway `Backend` (a connect/accept/read/write socket protocol) — that works
fine for a request/response-shaped service (`CloudStorageBackend`'s own
JSON-command socket, mirroring `fs-service-backend.mjs`), but does not
generalize to a publish/subscribe-shaped service with no natural "connect"
step. So `createBackend` is an **optional, additive capability** a
descriptor can declare, never a requirement of the base contract. CloudStorage
itself only uses its own `CloudStorageBackend` as a *local, in-process*
socket (`CloudStorage`'s own `#sendCommand()` talks to it directly) — the
netway registration via `network.addBackend()` is there purely for an
optional, advanced raw-socket use case (another local process, or a
debugging tool, connecting via `network.connect('s3-<bucket>://...')`), not
for anything CloudStorage's own `put`/`get`/`delete`/`list` need.

Four of CloudStorage's five composed services (`GrantLog`,
`key-distribution`, `manifest-sync`, `chunk-replication` — everything except
`CloudStorageBackend` itself) declare **no** `createBackend` at all — they
are pure message-passing services, attached with `network` entirely omitted.
That asymmetry (one service that's also a `Backend`, four that are pure
`attach()`-only) is exactly the case this contract's optionality exists for.

See `src/mesh-service.mjs`'s own module doc comment for the full API and its
one documented limitation (no `removeBackend()` — a registered `Backend`
stays routable on `network` for the network's lifetime).

## 2. The transport split: control plane vs. data plane

Every service in this family answers the same question — "how do bytes move
between peers?" — the same way: **one dispatch bus, split by traffic shape,
not by a second transport mechanism.**

- **Control plane** (small, structured messages: grant/revoke records,
  chunk-have queries, replication acks, manifest CRDT deltas): `ctx.sendTo()`
  / `ctx.onIncomingData()`, filtered by `envelope.type`. This is the *only*
  transport `mesh-sync.mjs`, `mesh-relay-host.mjs`, `grant-log.mjs`,
  `key-distribution.mjs`, and `manifest-sync.mjs` use.
- **Data plane** (the actual bulk bytes — CloudStorage's encrypted chunk
  content): also `ctx.sendTo()` / `ctx.onIncomingData()`, on the exact same
  bus, just with a different envelope `kind` (`chunk-push`,
  `chunk-fetch-response`) carrying a base64'd payload. `chunk-replication.mjs`
  is the reference implementation: no separate connection, no separate
  protocol — one `sendTo()` call per already-256KB-capped chunk (the cap
  `CloudStorageBackend`'s chunker already enforces on the write side), no
  further fragmentation or windowing. Documented explicitly in that file's
  own module doc comment as a deliberate "simplest thing that works" v1: a
  future revision could swap in raw binary DataChannel frames with real
  backpressure without touching any other phase's contract, because nothing
  outside `chunk-replication.mjs` depends on *how* the bytes moved.

**Why not `PeerSession`/`peer-files.mjs`'s `FileClient`?** The CloudStorage
plan's own original text suggested investigating `peer-files.mjs`'s existing
`FileClient`/`PeerSession` machinery as a data-plane counterpart for bulk
chunk transfer — it already has heartbeats, rate limiting, and an audit
trail, which sounds like exactly what chattier chunk traffic would want.
That investigation happened during Phase G (tracked as
`johnhenry/browsermesh` issue #84) and found a real, load-bearing fact this
guide exists partly to broadcast: **`peer-files.mjs`/`PeerSession`/
`SessionManager` are an entirely separate, unwired session architecture that
the real `PeerNode` composition root never touches.** Every real, connected
node in this repo — every `createMeshNode()` call, every `attachService()`
consumer, phases C through H of this very plan — is built on `PeerNode`'s
own `sendTo()`/`onIncomingData()` dispatch bus. There is no live bridge from
a `PeerNode`'s sessions to a `PeerSession`. Building Phase G on top of
`PeerSession`/`FileClient` would have required first solving issue #84's
much larger "bridge two independent session architectures" problem — out of
scope for a bulk-transfer phase. So `chunk-replication.mjs` builds **both**
planes directly on `PeerNode.sendTo()`/`onIncomingData()`, matching every
other phase in this plan, not a new bespoke transport and not `PeerSession`.

**The lesson for your next service:** when a plan document (or your own
first instinct) points at `peer-files.mjs`/`PeerSession` for anything, verify
it's actually wired to the real composition root before building on it —
it currently is not. Default to `ctx.sendTo()`/`ctx.onIncomingData()` for
everything, control and data alike, unless you've confirmed otherwise.

## 3. CRDT manifest + content-addressed encrypted chunks

CloudStorage's storage model splits into two layers with two different
trust/consistency stories, and keeping them separate is what makes the rest
of the design tractable:

- **The manifest** (`{chunks: [{cid, iv}], size, contentType, metadata,
  version, updatedAt}` per key) is an `LWWMap` CRDT (`browsermesh-primitives`),
  synced peer-to-peer as a `MeshSyncEngine` `SyncDocument`
  (`manifest-sync.mjs`, Phase F). It is the *pointer* — small, mergeable,
  eventually consistent.
- **Chunk content** is opaque, content-addressed (CID = hash of the
  *ciphertext*, not plaintext), stored/served byte-for-byte by
  `IndexedDBChunkStore` with zero awareness that encryption exists at all.
  Moving those bytes between peers is `chunk-replication.mjs`'s (Phase G) job
  entirely separate from the manifest sync above.

**Never trust a remote CRDT merge blindly.** `MeshSyncEngine.merge()` itself
has no concept of trust — it merges whatever `LWWMap` JSON it's handed. The
ACL gate therefore lives one layer above, in `manifest-sync.mjs`: on receipt
of a remote sync envelope, every entry's wire-level attribution field
(`nodeId`) is checked against `PeerRegistry.checkAccess(nodeId, resource,
'write')` — and against the connection-authenticated sender itself
(`nodeId === fromPubKey`, since there's no multi-hop relay trust chain in
this phase) — **before** any byte of it ever touches a constructed `LWWMap`
or the persisted manifest. Only the surviving, ACL-passed entries are merged.
This "sanitize the raw wire payload before it ever reaches the CRDT merge
step" pattern is the one to reuse verbatim for any future CRDT-synced,
multi-writer, access-controlled document.

**Documented, not fixed:** `LWWMap` resolves conflicts using
caller-supplied timestamps (highest wins; exact ties broken by whichever
`nodeId` string sorts greater) — no server-clock arbitration, no per-field
merge, no surfaced conflict. Two peers writing different content to the same
key at "the same time" resolve to one silent winner. This mirrors
un-versioned S3's own real default behavior and is treated the same way
here: a stated, permanent v1 limitation, not a bug backlog item.
`test/real-peer/cloud-storage.test.mjs`'s "concurrent same-key writes"
suite (Phase K) demonstrates this holds over a real connection, not just in
theory.

Encryption itself is a layer *above* the chunk store, not a chunk-store
concern — `IndexedDBChunkStore`/the in-memory `ChunkStore` stay completely
unaware encryption exists; `CloudStorageBackend` encrypts before chunking
and computes CIDs over ciphertext, so every replica verifies and stores the
identical ciphertext bytes regardless of which peer produced them.

## 4. Signed, replicated GrantLog for multi-peer-enforced ACL

`PeerRegistry.grantCapabilities()` is entirely local — it mutates the
granting peer's own ACL bookkeeping and transmits nothing. That's sufficient
when one peer enforces its own access decisions (this family's earlier
mesh-relay work), but a *replicated* resource has multiple peers each
independently enforcing access, so authorization itself has to propagate,
not just get decided once.

`grant-log.mjs`'s `GrantLog` is the reusable answer: an `or-set` CRDT
(`browsermesh-primitives`, no new CRDT type needed) of signed
`{pubKey, scope, action: 'grant'|'revoke', at, signedBy, signedByPubKeyBytes,
signature}` records, synced via the same `MeshSyncEngine` machinery the
manifest itself uses. Every peer verifies a record's Ed25519 signature (self-
verifying — the record carries the signer's own public key bytes, so no
out-of-band directory lookup is needed) before applying it, then replays the
merged, verified log through its own **unchanged** local
`PeerRegistry.grantCapabilities()`/`revokeCapabilities()`. `PeerRegistry`
itself needs zero modification — the whole point of this pattern is that the
already-proven local enforcement primitive gets reused untouched; only the
*propagation* of the decision that feeds it is new.

Scope grammar is generic and resource-agnostic (`<resource>:<action>`,
e.g. `s3:my-bucket:read`) — CloudStorage's 6 actions
(`read`/`write`/`delete`/`list`/`admin`/`replica`) are just this module's
first caller-supplied values, not anything hardcoded in `grant-log.mjs`
itself. A future service with a different action vocabulary (`queue:my-q:
publish`/`subscribe`, say) reuses this file verbatim.

Replica designation (Phase D's own extension for CloudStorage specifically)
is implemented as a sixth ordinary action-scope (`s3:<bucket>:replica`), not
a separate mechanism — worth knowing if your own service needs an analogous
"which peers hold a copy" concept: it's very likely just another scope, not
new plumbing.

## 5. Bucket-key distribution

Once the GrantLog admits a new `read`-or-above grant, someone who already
holds the resource's symmetric key needs to get it to the newly-granted
peer. `key-distribution.mjs` does this over a dedicated, signed,
point-to-point channel (`PeerNode.sendTo()`), encrypted to the recipient's
identity. Ed25519 identity keys can't do ECDH directly, and there was no
existing Ed25519-to-X25519 conversion utility in this repo — Phase E's real
finding was that `browsermesh-core`'s existing `wrapKeyForMember()`/
`unwrapKeyForMember()` (X25519 ECDH + AES-GCM, already tested, built for an
unrelated group-membership feature) already solves exactly this shape of
problem, so Phase E reuses it rather than adding a new crypto primitive.
**The lesson:** check `browsermesh-core`/`browsermesh-primitives` for an
existing primitive before assuming your service needs a new one — this
family has a habit of already having the piece you need one file away from
where you first looked (chunk-replication's `PeerSession` non-finding in
§2 above is the same lesson in the opposite direction: sometimes the
existing piece looks right and isn't actually wired up — verify either way).

**Permanent limitation, stated plainly, not buried in a comment:** revoking
a grant stops *future* key distribution and *future* replication to that
peer, but cannot retroactively erase a key — or any plaintext already
decrypted with it — already delivered before the revoke. No key rotation on
revoke exists anywhere in this plan. This is a fundamental property of
handing symmetric key material to multiple independent parties (the same is
true of a downloaded S3 object whose bucket policy changes afterward), not
something to "fix" later — say so in your own service's docs the same way,
not as an implementation detail a caller has to discover the hard way.

## 6. UX prior art worth one line

[`ngrok/webernetes`](https://github.com/ngrok/webernetes) solves an
unrelated problem (an in-browser, no-persistence, no-cross-machine-network
simulator of Kubernetes API objects), but its `BaseImage`/
`ctx.listenHttp(port, handler)` pattern — define a service as a small class
with an entrypoint, then declaratively `registerImage()`/`apply()` it into
existence — is clean prior art for the kind of ergonomic service-definition
API `MeshService`/`attachService()` is aiming for: a small, explicit
descriptor plus a `ctx` object that hands the service exactly the
capabilities it needs, nothing more. Worth knowing about; not a dependency,
not integrated.

## Worked example

`examples/09-cloud-storage.mjs` is the full `new CloudStorage(...)` story
end to end, runnable with plain `node`. `test/real-peer/cloud-storage.test.mjs`
proves the identical composition over an actual WebRTC connection (gated
behind the optional `node-datachannel` devDependency, `REQUIRE_REAL_PEER=1`
in CI). `src/cloud-storage.mjs`'s own module doc comment is the single best
next read if you're building the next mesh-native service: it documents
several real gaps the plan's original brief left open and exactly how/why
each was resolved during implementation, which is the same kind of
first-hand record this guide is trying to save your next service from
having to rediscover.
