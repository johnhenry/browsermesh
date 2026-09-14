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

`MeshKv` (`src/mesh-kv.mjs`) is the second, built by the mesh-KV-and-
observability plan (`mesh-kv-and-observability.md`) specifically to find out
whether the patterns below actually generalize, or whether they were
accidentally CloudStorage-specific. Sections 7 and 8 below are that plan's
own capstone phase, added once `MeshKv` and its companion
`observability-bridge.mjs` had shipped and could be checked against reality
rather than guessed at in advance.

Section 9 below is a different kind of addition, not another `MeshService`
worked example: the agent tool-calling runtime plan (issues #90/#92)
introduced a second, complementary convention — `BrowserTool`/
`BrowserToolRegistry`/`createAgentRuntime` — for exposing capabilities to an
LLM-driven agent loop rather than to another peer. It's documented here
because it reuses this guide's `checkAccess()`-gating lesson directly (§9c),
not because it's another flavor of `MeshService`.

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
chunk transfer — it already had heartbeats, rate limiting, and an audit
trail, which sounds like exactly what chattier chunk traffic would want.
That investigation happened during Phase G (tracked as
`johnhenry/browsermesh` issue #84) and found a real, load-bearing fact this
guide exists partly to broadcast: **at the time, `peer-files.mjs`/
`PeerSession`/`SessionManager` were an entirely separate, unwired session
architecture that the real `PeerNode` composition root never touched.**
Every real, connected node in this repo — every `createMeshNode()` call,
every `attachService()` consumer, phases C through H of this very plan —
was built on `PeerNode`'s own `sendTo()`/`onIncomingData()` dispatch bus.
There was no live bridge from a `PeerNode`'s sessions to a `PeerSession`.
Building Phase G on top of `PeerSession`/`FileClient` would have required
first solving issue #84's much larger "bridge two independent session
architectures" problem — out of scope for a bulk-transfer phase. So
`chunk-replication.mjs` built **both** planes directly on
`PeerNode.sendTo()`/`onIncomingData()`, matching every other phase in this
plan, not a new bespoke transport and not `PeerSession`.

**Update:** issue #84's own later app-layer migration plan resolved this
for good rather than just working around it — `peer-files.mjs` (and
`peer-chat.mjs`, `peer-terminal.mjs`) were subsequently migrated off
`PeerSession` onto this same `MeshService`/`ctx.sendTo()`/
`ctx.onIncomingData()` convention, and `peer-session.mjs`'s `PeerSession`/
`SessionManager` were deleted from the repo entirely once nothing
depended on them anymore (issue #84's final phase). `PeerSession` no
longer exists here in any form — every mention of it in this section is
historical, describing why an earlier phase didn't build on it, not a
live architecture to route around today.

**The lesson for your next service, still valid:** when a plan document (or
your own first instinct) points at some existing machinery for anything,
verify it's actually wired to the real composition root before building on
it — `PeerSession` wasn't, back when this section was written. Default to
`ctx.sendTo()`/`ctx.onIncomingData()` for everything, control and data
alike, unless you've confirmed otherwise.

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

## 7. The `ctx.emit()` observability convention

Every service documented above answers "how do I move bytes/state between
peers." None of them answer a different, equally real question: "how does
*anything outside this service* — a dashboard, `visualizations.mjs`, a test
assertion — find out something meaningful just happened?" Before the
mesh-KV-and-observability plan, the only answer was `onLog(event, data)` —
free-form, mostly error/reject-path debug logging, no fixed vocabulary, and
(by convention, not enforcement) not something a caller should build real
behavior on top of. `ctx.emit()` is the deliberate second answer, added to
`mesh-service.mjs` alongside `ctx.sendTo()`/`ctx.onIncomingData()`:

- **`onLog` and `emit` are separate hooks with separate jobs, not two ways
  to do the same thing.** `onLog` stays exactly what it always was. `emit`
  is for a small, *curated* set of meaningful state transitions a service
  deliberately chooses to publish — grant applied, chunk replicated, entry
  set, connection opened — typically 3-5 per service, not a mechanical
  onLog-to-emit conversion of every line. If you're tempted to `emit()`
  something whose only audience is "future-me debugging a failure," that's
  an `onLog` call, not an `emit()` call.
- **Event naming grammar**: `<service-name>:<kebab-case-description>`,
  matching the `<service>:<event>` shape `onLog` already established across
  every file in this guide (`grant-log:grant-applied`,
  `chunk-replication:chunk-replicated`, `mesh-kv:entry-set`). Document your
  service's chosen vocabulary in its own module doc comment — every service
  in this repo that emits anything does this (see `mesh-kv.mjs`'s
  "Observability events" section for a worked example of the format:
  event name, payload shape, one sentence on when it fires).
- **Subscription lives on `attachService()`'s returned handle**, not on
  `createMeshNode()`'s aggregate — each attached service gets its own
  independent event bus, the same way each already gets its own `ctx`:
  - `handle.on(event, callback)` — `callback(data)` fires only for that
    exact event name. Returns an unsubscribe function.
  - `handle.onEvent(callback)` — `callback(event, data)` fires for every
    event that service ever emits, regardless of name — the "firehose"
    subscription a generic bridge/dashboard wants instead of enumerating
    every event name a service might add later.
  - A composed, non-`MeshService` class with no `ctx` of its own (like
    `MeshKv`, which internally calls `attachService()` twice but isn't
    itself attached by anything) can build its own bus with the identical
    shape via the separately-exported `createEventBus()` — see `mesh-kv.mjs`
    for how `MeshKv.on()`/`.onEvent()` forward `createMeshKvService()`'s own
    vocabulary unchanged onto the wrapper's public surface.
  - `emit()` fires synchronously (no queueing, no microtask hop) and a
    throwing subscriber is caught and swallowed — it can never crash the
    emitting service or break another subscriber. See `mesh-service.mjs`'s
    own module doc comment for the full contract, including why there is
    deliberately no log sink inside the bus itself.
- **A curated consumer, not a rewrite of what it consumes**:
  `observability-bridge.mjs` is the reference example of building on top of
  `ctx.emit()` — it subscribes to `handle.on()`/`handle.onEvent()` for
  whichever services a caller passes to `bridge.observe(handle)`, and turns
  a hand-picked subset of events into `visualizations.mjs`'s
  `TopologySnapshot`/`TrustHeatmap`, then exports them as JSON via the
  *unmodified* `VisualizationExporter`. It is deliberately conservative
  about which events it wires (documented per-service, with reasons, in its
  own module doc comment) rather than mechanically wiring everything — the
  same "curate, don't dump" principle `ctx.emit()` itself asks of a service
  choosing what to publish, applied one layer up by whatever consumes it.

## 8. Second service, worked: what generalized from CloudStorage, what didn't

`MeshKv` (`src/mesh-kv.mjs`) is smaller than CloudStorage on purpose — an
`LWWMap`-backed KV store with no chunking, no content-addressing, no
encryption-at-rest requirement — precisely so it could stress-test *this
guide's* claims without a second phase's worth of unrelated complexity
(encryption, bucket-key distribution) obscuring which lessons actually
transfer. The honest accounting:

**Reused near-verbatim: the ACL-gate-before-merge pattern.**
`manifest-sync.mjs`'s core property — sanitize the raw wire payload against
`PeerRegistry.checkAccess()` *before* any byte reaches a CRDT merge, not
after — transferred to `mesh-kv.mjs` almost unchanged. Both files walk
inbound entries, check `nodeId === fromPubKey` (no multi-hop relay trust),
check `checkAccess(writer, resource, 'write')`, and only merge what survives
both checks. This is the one piece of `manifest-sync.mjs` this guide
predicted would generalize (§3, "the one to reuse verbatim for any future
CRDT-synced, multi-writer, access-controlled document"), and it did, exactly
as predicted — worth noting since not every prediction below held up as
cleanly.

**NOT reused: the second-source-of-truth-mirroring machinery.** This is the
concrete lesson, not a gestured-at one. `manifest-sync.mjs` exists because
CloudStorage's manifest is a *pointer* into a separately, independently
durable backend (`CloudStorageBackend`, its own `IndexedDBSyncStorage` and
encryption pipeline) — the CRDT document has to be kept in sync with that
other, already-authoritative copy: `getManifestSnapshot()` to read it,
`onManifestChange()` to hear about local writes to it, `mergeManifestEntries()`
to write merged remote state back into it, plus real ordering questions
("did the backend's mutation land before I broadcast the CRDT change?").
`MeshKv` has no such second source: its `MeshSyncEngine`'s own `LWWMap`
(`InMemorySyncStorage`-backed) *is* the store's authoritative state, full
stop. A local `set()`/`delete()` calls `engine.update()` directly, and
`MeshSyncEngine`'s own subscriber notification on that update *is* the
local-write-triggers-broadcast path — no bridging code in between, because
there is nothing on the other side of a bridge to keep in sync with.

**The general question for your own next service**: does the CRDT document
*point at* some other already-durable, already-authoritative store (a
chunked blob backend, a filesystem, an external database), or does the CRDT
document *hold* the actual state? If it points elsewhere, you need
`manifest-sync.mjs`'s shape — a mirror, with the ordering/staleness
questions that implies. If the CRDT document holds the state itself, you
need `mesh-kv.mjs`'s much shorter shape — no mirror, because there's nothing
to mirror. Guessing wrong here doesn't fail loudly; it just means either
building unnecessary bridging code (if you copy `manifest-sync.mjs`'s shape
when you didn't need it) or silently having two copies of "the truth" that
can drift (if you copy `mesh-kv.mjs`'s shape when you actually needed a
mirror) — decide this explicitly, in your own service's module doc comment,
the way both files here do.

**A real implementation pitfall found while building
`examples/10-mesh-kv-and-observability.mjs`, since fixed** (see
[#112](https://github.com/johnhenry/browsermesh/issues/112)):
`MeshSyncEngine.merge()` (`packages/browsermesh-sync/src/sync.mjs`) used to
notify subscribers unconditionally — even when a merge changed nothing (an
already-known entry, re-delivered). Combined with `mesh-kv.mjs`'s `watch()`
(broadcast on every document-changed notification to every watched peer),
two peers that both `watch()` each other *and* have each authored at least
one entry could enter an unbounded broadcast/re-merge/re-notify cycle: each
side's own authored entries always pass the *other* side's "attribution must
match the immediate sender" check on every hop, so nothing ever broke the
loop, and because delivery here rides `queueMicrotask()`, it starved the
event loop's macrotask queue rather than merely running hot.

`MeshSyncEngine.merge()` now compares the remote payload's vector clock
against the local document's before deciding whether to notify: if the
local document's version already causally dominates (or equals) the
remote's, the remote carries no information the document hasn't already
incorporated, so the merge is guaranteed to be a value-level no-op and the
notification is skipped — while a merge that genuinely advances either
side's state still notifies as before, so real propagation and convergence
are unaffected. This means **mutual, persistent `watch()` between two
peers who both author entries is now safe** — you no longer need to fall
back to a one-shot `syncWith(pubKey)` push in one direction to avoid this.
The worked example below still uses that one-shot `syncWith()` pattern for
bob's side (it mirrors `MeshKv.grant()`'s own push-with-retry style and
remains a perfectly reasonable way to drive a first sync), not because
mutual `watch()` would be unsafe.

## 9. A different, complementary pattern: `BrowserTool` / `BrowserToolRegistry` / `createAgentRuntime`

Everything above is the `MeshService` pattern: how a capability attaches to
a `PeerNode` and talks to other peers over the wire. This section documents
a **different** pattern, built by the agent-runtime plan (issues #90/#92,
`johnhenry/browsermesh` PRs #141/#143/#144/#145 plus this guide's own
update) specifically because it answers a different question:
`MeshService` is "how a capability attaches to a `PeerNode`"; `BrowserTool`/
`BrowserToolRegistry`/`createAgentRuntime` is "how you expose local OR
mesh-backed capabilities to an LLM-driven agent loop." Don't reach for this
pattern to build a new mesh-native service — reach for it when an *agent*
(LLM-driven code, not a peer) needs a structured way to call into one.

The three pieces, each staying in its own lane:

- **`BrowserTool`** (`compat.mjs`) — a small base class: `.spec`
  (`{name, description, parameters, required_permission}`, the
  OpenAI-function-calling-shaped object an `llmFn` translates into its own
  vendor's tool-definition format) plus `.execute(params)`. This package and
  `browsermesh-core` each vendor their own copy (the family's established
  "standalone use" philosophy — see `compat.mjs`'s own header) rather than
  one depending cross-package on the other for something this small.
- **`BrowserToolRegistry`** (`compat.mjs`) — holds any number of constructed
  `BrowserTool` instances: `register`/`get`/`list`/`listSpecs`/`unregister`.
  Duck-typed validation (a working `.spec` getter + `.execute()` method), not
  `instanceof` — see the next section for exactly why that matters.
- **`createAgentRuntime({registry, llmFn, maxTurns?, onLog?})`**
  (`agent-runtime.mjs`) — the actual conversation loop. **Browsermesh never
  calls a real LLM API itself** — no Anthropic/OpenAI SDK dependency
  anywhere in this family, confirmed by grep at the start of this plan.
  `llmFn(messages, toolSpecs) -> {content?, toolCalls?}` is REQUIRED, with no
  default implementation shipped, matching `mesh-compute.mjs`'s `executeFn`/
  `mesh-agent-swarm.mjs`'s `agentProxy` "bring your own X, required, no
  silent no-op default" precedent this whole family already established. The
  loop dispatches each requested tool call through `registry`, appends a
  `{role: 'tool', tool_call_id, name, content: JSON.stringify(result)}`
  message per call, and calls `llmFn` again — stopping on a `content`-only
  response, or after `maxTurns` (default 10) round-trips, returning a
  `{..., truncated: true}` result rather than throwing (a real caller
  building a chat UI is better served inspecting/resuming a partial result
  than unwinding a thrown exception — see `agent-runtime.mjs`'s own module
  doc comment for the full reasoning).

`mesh-orchestrator-tools.mjs`'s `registerOrchestratorTools()` is the worked
example tying a *mesh-backed* capability into this pattern: it constructs
`orchestrator.mjs`'s 8 real `Meshctl*Tool`s against a real, attached
`mesh-orchestrator.mjs` service and registers them into a
`BrowserToolRegistry` — `createMeshNode({enableAgentRuntime: true,
enableOrchestrator: true})` wires all of it, handing back
`node.toolRegistry` pre-populated and ready for
`createAgentRuntime({registry: node.toolRegistry, llmFn})`.

### Three lessons from building this, for your own next `BrowserTool`

**(a) Two inconsistent dependency-injection patterns already exist across
this repo's ~50 pre-existing, previously-dormant `BrowserTool` subclasses —
know which one you're looking at, and use constructor injection for
anything new.** `peer-tools.mjs`/`tools.mjs` (`browsermesh-core`/`-apps`)
predate this plan and use a fragile module-singleton "context" object —
`tools.mjs`'s own `MeshToolsContext`/`meshToolsContext`, a `set*`/`get*`
grab-bag (`setMultiplexer`/`getMultiplexer`, `setDhtNode`/`getDhtNode`,
etc.) tool instances reach into at `execute()` time. It works, but it's
fragile in the ways module-singleton state always is: only one live value
per dependency process-wide, easy to forget to `set*()` before a tool's
first `execute()`, and no way to run two independently-configured registries
of the same tools in one process. `orchestrator.mjs`'s 8 `Meshctl*Tool`s, by
contrast, use proper constructor injection (`constructor(orchestrator) {
this.#orchestrator = orchestrator }`) — each instance owns its own
dependency, no shared mutable module state, trivially supports multiple
independently-configured registries. **This plan deliberately did not
rewrite the ~50 existing module-singleton-style tools** — disproportionate
scope for what was fundamentally a "the registry/runtime didn't exist at
all" gap (see this plan's own "Design decisions" section) — but
`BrowserToolRegistry.register()` doesn't care either way (it only needs a
constructed instance with a working `.spec`/`.execute()`, how that instance
got its own dependencies is the tool's own business). **Recommendation for
any new `BrowserTool` you write**: use constructor injection
(`orchestrator.mjs`'s shape), not the module-singleton-context shape — it
composes better, and it's what this plan's own new code (the 8
`Meshctl*Tool`s, already-existing) demonstrates working cleanly end to end.

**(b) A `BrowserTool` extending the wrong environment's stub silently fails
registry validation — check which `BrowserTool` your class is actually
extending.** `orchestrator.mjs` predates `compat.mjs`'s real `BrowserTool`
and was written to interoperate with a real, browser-only, richer
`globalThis.BrowserTool` (clawser's own, in a real browser), falling back to
`class { constructor() {} }` — a do-nothing stub, no `.spec` getter at all —
whenever `globalThis.BrowserTool` was undefined (plain Node, e.g. this
package's own test suite, or any standalone use of `orchestrator.mjs`). That
fallback silently broke `BrowserToolRegistry.register()` for all 8
`Meshctl*Tool`s in Node: `.spec` composes `{name, description, parameters,
required_permission}` from each subclass's own overridden getters, which
only exist on `compat.mjs`'s real `BrowserTool` base class — the stub has no
`.spec` getter to inherit from at all, so `looksLikeBrowserTool()`'s
`tool.spec` probe threw, and `register()` rejected every one of the 8 tools
with no explanation beyond a generic `TypeError`. Found and fixed in Phase 4
(`mesh-orchestrator-tools.mjs`'s own PR): `orchestrator.mjs` now falls back
to `compat.mjs`'s real `BrowserTool` instead of the do-nothing stub —
`const BrowserTool = globalThis.BrowserTool || CompatBrowserTool` — real
`globalThis.BrowserTool` (a real browser) is still honored first, changing
nothing about the 8 subclasses' own bodies, only what a Node-side
`.spec`/default `execute()`/`permission` resolves to when no browser-only
override exists. **The general lesson**: if you're writing (or debugging) a
`BrowserTool` meant to run in both a real browser and plain Node, check
which class your file's own environment-detection fallback actually resolves
to outside a browser — a stub with no `.spec` getter fails
`BrowserToolRegistry.register()` silently (a generic `TypeError`, not an
error that names the missing `.spec` getter specifically), exactly the kind
of gotcha worth a code comment at the fallback itself, the way
`orchestrator.mjs` now has one.

**(c) Gate risky actions through the `MeshService`'s own
`checkAccess()`-protected `api`, not the raw underlying class — reachable
`BrowserTool`s inherit whatever gate (or absence of one) their constructor
argument has.** `MeshOrchestrator`'s own `execOnPod`/`deploySkill`/
`drainPod` methods (`orchestrator.mjs`) have no authorization check
whatsoever built in — calling them directly, in-process, just runs, using
whatever peer callback happens to be registered via `addPeer()`. The real
gate lives one layer up, in `mesh-orchestrator.mjs`'s `MeshService` wrapper
(Phase 3): `api.execOnPod`/`api.deploySkill`/`api.drainPod` always dispatch
a genuine `'orchestrator-request'` over the wire to the target peer (a
self-targeted call stays local, no gate needed — there's no peer boundary to
cross), and *that peer's own* `ctx.registry.checkAccess(fromPubKey,
'orchestrator', action)` is what actually decides whether to honor it — the
real authorization boundary this whole "risky, peer-initiated action"
design exists for. When Phase 4 constructed the 8 `Meshctl*Tool`s
(`mesh-orchestrator-tools.mjs`), it would have been the more literal reading
of "construct `Meshctl*Tool(orchestrator)` against the raw instance" to wire
them straight to `api.orchestrator`'s raw methods — reachable, and exposed
on `api` precisely so this later phase could do so. **That would have been
wrong**: `api.orchestrator` doesn't re-add the gate `MeshOrchestrator`'s own
methods never had, so an LLM-drivable `meshctl_exec` wired that way would
run any remote command a caller asked for, no authorization check at all.
Phase 4 instead built a small facade
(`mesh-orchestrator-tools.mjs`'s `buildToolFacade()`) that routes
`meshctl_exec`/`meshctl_deploy`/`meshctl_drain` specifically through
`api.execOnPod`/`api.deploySkill`/`api.drainPod` (the gated wire-dispatch
methods), while `meshctl_pods`/`meshctl_status`/`meshctl_top` (ungated even
at the service layer — pure local aggregation, no peer-initiated request
path exists for them at all) and `meshctl_compute`/`meshctl_expose` (no
gated equivalent exists at the service layer *at all* — Phase 3's own
`RISKY_ACTIONS` never included `compute`/`expose`, documented rather than
silently worked around) still go straight to the raw instance, since there
is no gated alternative to prefer for those five. **The general lesson for
your own next tool wired against a `MeshService`**: before handing a
`BrowserTool` (or anything else reachable by untrusted input) a
constructor-injected dependency, ask whether that dependency is the gated
service `api` or the raw underlying class — if the raw class has no
authorization of its own (most don't; gating is the service wrapper's job,
not the wrapped class's), a tool built directly against it inherits that
same absence of a gate, silently.

## Worked examples

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

`examples/10-mesh-kv-and-observability.mjs` is the `MeshKv` counterpart —
three real peers, `MeshKv`'s underlying services composed by hand
(`createGrantLogService()` + `createMeshKvService()`, the same composition
`MeshKv`'s own constructor performs, done explicitly here so both services'
`attachService()` handles are available to observe), an `observability-bridge`
watching live `ctx.emit()` output, and its `VisualizationExporter` JSON
printed as the payoff — the real grant that raised a trust value, the real
authorized write that bumped an edge's activity counter, and the real
unauthorized write that got refused, all visible in one exported JSON
object at the end, not asserted in a test file no one reads.

`examples/11-agent-tool-calling.mjs` is §9's worked example — the
`BrowserTool`/`BrowserToolRegistry`/`createAgentRuntime` pattern, not the
`MeshService` pattern the examples above demonstrate. Two real
`createMeshNode()` peers (one with `enableOrchestrator` +
`enableAgentRuntime`, pre-populating `node.toolRegistry` with all 8 real
`Meshctl*Tool`s), a deterministic test `llmFn` (no real LLM API call), and a
real `createAgentRuntime()` loop: the LLM requests `meshctl_pods`, sees the
real remote peer in the result, requests the genuinely risky
`checkAccess()`-gated `meshctl_exec` against it, and summarizes both real
results as its final answer — printed alongside the full message-by-message
transcript the loop actually produced.
`packages/browsermesh-apps/test/mesh-orchestrator-tools.test.mjs`'s own
CAPSTONE describe block proves the identical wiring with `assert`-backed
coverage (including the denied-vs-authorized `meshctl_exec` contrast this
example only exercises the authorized half of); this example is the
narrated, printed-output counterpart for a human reader, the same
relationship `09`/`10` already have to their own test suites.
