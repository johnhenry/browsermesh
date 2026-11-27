# Realms: a portable way to say "this is the mesh, and this is who may be in it"

Status: **partly built; no realm is enforced by a running node yet.** Written 2026-11-26 as a proposal (PR #406), revised the
same day after a reverse review, and revised again after the first stages were built, so that the page matches the code.
Section 2 is what the owner has decided, section 10 what is still open, section 11 the staged order with where each stage
stands, section 12 what the review changed and section 13 what the implementation changed.

- **Merged on `main`:** strict canonical JSON in primitives (#414); the wallet seed and per-realm identity derivation in
  core (#415), with the browser derivation spec (#407); `createMeshNode({ identity })` (#416); the realm grant source in
  `PeerRegistry` (#417); link admission, the restricted-link seam (#419, made fail-closed with an older transport in #427);
  `browsermesh-realm`, the pure-logic core (#420; published to npm as 0.1.0 by its first-release PR); the realm exchange (frames,
  descriptor store, verifier, prover; #426); the fix that makes the seam's `send` never reject on a closed link (#441); and
  stage 4, `createMeshNode({ realm })`, `node.realm` and renewal over a `realm` protocol (#445).
- **Also merged:** the `meshctl realm` commands (#424), example 26 (#442) and the tour, example 28 (#455); the realm package
  is on npm as 0.1.0 (#454).
- **Not built:** tickets and admitters; live peer listing in `meshctl realm inspect`; seed management in meshctl (it makes
  one independent random key per realm); synchronising one realm across several nodes of the same operator; federation; an
  issuer add, renew or replace command.

Claims about #424 (meshctl) below were checked against that branch before it merged (it is on `main` now).

## 1. The problem

A web app, a CLI or a host that wants to join a mesh today needs a pile of separate things: a signalling URL, a wsh relay,
ICE and TURN settings, bootstrap hosts, and, afterwards, grants on every host it will talk to. There is no single object
that says "this is the mesh" and nothing that says "this key may be in it". An app author who wants to ship an app that
joins one particular mesh has to assemble and bake in that pile by hand, and has no way to tell a stranger's pod from a
member's.

What exists and is reused (each line was checked against the source in the review):

- **Identity.** A pod id is the hash of an Ed25519 key (`browsermesh-primitives/src/identity.mjs`). A wsh link proves the
  peer's key at login. A WebRTC link proves it only when identity binding is on; `webrtcAllowUnboundPeers` can turn that off.
- **Authorisation.** `PeerRegistry` (`browsermesh-apps`) grants are default-deny, per peer and scope, with wildcards and
  expiry. The protocol seam consults it on every request. `createWshAuthorizer` consults it at wsh login.
- **Capability tokens** (`browsermesh-core/src/capabilities.mjs`): issuer-signed, `holder` is a signed field, narrowable by
  delegation, with expiry. Nothing makes the presenter prove it is the holder.
- **Session certificates and signed revocations** (`browsermesh-primitives/src/session.mjs`), unused by anything else
  today; their conventions (a 300 s skew cap, a verifier-side lifetime limit) are reused here.
- **Host description**: `meshctl host describe` already returns a host's lane, verbs and capabilities.

What is missing is the realm itself: its identity, its rendezvous information, its policy, and the credentials that say who
belongs. What the review found is also missing is **a place to present a credential** and **a grant source that does not
collide with the operator's own grants** (sections 5.5 and 7).

## 2. Decisions already made (owner, 2026-11-26)

- Realms are **both public and private**.
- An always-on peer is **optional, and the realm defines whether it has one**.
- **Eventual revocation is acceptable**, especially where there is no always-on peer.
- The name is **realm**. ("Network" is taken: `VirtualNetwork` in `browsermesh-netway` is something else.)
- **One identity per realm**, so realms cannot correlate a user across each other. Per-realm keys are **derived from one
  seed**, so a single backup recovers every realm identity (see 5.10 for what that needs). The seed is **extractable and
  exported only under a passphrase**; if derivation fails in any of Chromium, Firefox or WebKit, v1 **falls back to
  independent random keys per realm**, with one backup per realm and the limitation documented.
- **Derivation is HKDF-SHA-256** over a random 32-byte seed, with a context string that contains the realm id, and the
  backup is a **passphrase-encrypted file** built on the identity manager's existing passphrase export. No recovery phrase
  in v1, and never a key derived straight from a passphrase.
- Seed derivation is relied on only if it **passes in all three of Chromium, Firefox and WebKit** (the repo's required
  browser checks); if it fails in any, v1 takes the fallback above.
- **Who persists the seed (decided by the owner while the wallet was built):** the **app** stores the passphrase-sealed seed
  export; the wallet does not persist the seed, and `save()` does not write derived identities (they are re-derived from
  the seed). Built that way (5.10).
- A peer adopts a **higher-serial descriptor offered by another peer only after verifying it** end to end against the
  pinned realm id and chain (5.2); it never adopts an unverified one.
- The **authority-less open realm** exists as its own form, with its rendezvous information kept outside the hash (5.9).
- **Root rotation is in v1** (5.1), with a fork rule.
- The **keyless "any holder" credential is not in v1.** Open mode covers a baked-in app that needs only the guest role; a
  ticket covers one that needs more.
- The code lives in a **new package, `browsermesh-realm`**, with the dependency rules in section 7.
- Descriptors and credentials are **canonical JSON with Ed25519, with test vectors**, under the strict profile in 5.2.
- The default credential **`ttl` is 7 days** (a realm may set its own), which is also the default worst-case revocation
  delay; the verifier's **clock-skew tolerance is 5 minutes** (never more than session certificates' 300 s cap).

## 3. Terms

| Term | Meaning |
| --- | --- |
| **Realm** | A membership and policy domain: an id, a root authority, rendezvous information and a set of roles. It carries no packets; it is not a netway network. |
| **Descriptor** | The signed, public document that describes a realm. Safe to ship in a web app. |
| **Root** | The realm's root key. Kept offline; signs the descriptor and delegates to issuers. |
| **Issuer** | A key the root has delegated to, used day to day to sign credentials. Delegation is exactly one level deep. |
| **Role** | A named bundle of scope patterns, defined in the descriptor as an **upper bound** (principle 2). |
| **Credential** | An issuer-signed statement that one pod (named by its pod id, the hash of its key) has a role in this realm until a time. |
| **Ticket** | A single- or N-use token redeemed once for a credential bound to the redeemer's own key. |
| **Realm exchange** | The short in-band conversation on a new link that presents the descriptor and credential (5.5). |
| **Ledger** | The issuer's local record of every credential and ticket issued. |

## 4. Principles

1. **Keep five questions apart**: discovery (finding peers), authentication (who is this key), authorisation (what may it
   do), connectivity (a working path), membership (is it in the realm). A realm answers only the last, and feeds the third.
2. **Local policy always wins, by mechanism.** A descriptor's role is an upper bound, not a grant. Each host holds a
   **realm policy**: which realm ids it honours and, per role, an allow list of scope patterns. A role scope outside that
   list is dropped and logged. `egress:`, `ingress:`, `pod-host` and `wsh-` scopes are never granted from a realm unless the
   host's policy lists them. A descriptor containing a wildcard or a short scope (an empty or missing segment matches
   anything under `matchScope`) is rejected at parse. Built so: in `browsermesh-realm` a scope is `ns:resource:action`
   written out in full, and a two-segment form such as `mcp:tool` is a wildcard under `matchScope`, so a role must write
   `mcp:tool:call`. In the registry the same scopes **throw** a `TypeError` at grant time (a caller bug), while a policy
   refusal (a realm or role the host does not honour, a scope outside the allow list) is a **drop**, reported through
   `onRealmGrantDropped`. A sensitive scope (`egress:`, `ingress:`, `pod-host`, `wsh-`) is admitted only by an allow-list
   pattern that itself starts with that prefix; `*:*:*` does not count.
3. **Anything baked into a page is public.** The design assumes every visitor can read it.
4. **Enforcement is at the peers.** Relays and signalling servers stay dumb rendezvous.
5. **No roster.** A peer proves it is a member when it links; nobody keeps a list.
6. **Browser-usable.** The descriptor lists only what a page can use: signalling URLs, wsh relays, ICE and TURN, bootstrap
   hosts. No mDNS, QUIC or raw TCP.
7. **Direct links only.** A credential is honoured only on a direct link that proved its peer's key. Routed paths and
   unbound WebRTC links are refused. For WebRTC "proved" means the identity binding verified
   (`adapter.peerConnection.bound === true`); for wsh it is always true. The exchange refuses an unproven link for everyone,
   guests included.

## 5. The objects

### 5.1 Realm id, root and rotation

The id is derived from the **first** root key (the genesis key), so rotating the root does not change the id and apps pin
one id forever. One root key is one realm. A rotation is a statement signed by the outgoing root, naming the successor, a
position in the chain and an effective time, **countersigned by the successor** to prove it holds the key.

**Fork rule.** A verifier that already holds a chain position never accepts a different statement for that position
(first seen wins). A verifier pinned only to the genesis key takes the chain carried by the highest-serial descriptor it
can verify end to end. **Known limit:** a retired root key that later leaks can sign a competing successor before a given
verifier has seen the real rotation; a fresh page with only the genesis key cannot tell the two apart. Rotation therefore
limits the damage of key aging and planned changes, not of compromise. A compromised current root ends the realm, and the
note says so rather than imply otherwise. The chain length is capped, and a verifier checks a chain only when its serial is
higher than the one it holds.

### 5.2 Descriptor

Fields (names are a sketch): `v`, `id`, `name`, `serial` (monotonic), `epoch` (5.7), `mode` (`open` or `invite`), `root`
(current key and chain), `issuers` (keys, each with its own expiry), `roles`, `rendezvous` (signalling, wsh relays, ICE and
TURN, bootstrap hosts), `admitters` (hosts that redeem tickets; may be empty), `updateUrl` (optional), `ttl`, `revoked`
(a bounded list of credential serials, 5.7), `validUntil` (optional: a baked snapshot older than this must be refreshed),
`labels` (discovery metadata only, never used for authorisation), `extensions`. Signed by the root. A descriptor has a size
limit.

**Canonical profile.** The same bytes must verify in every language, so the profile is strict: sign the exact received bytes
and reject any input that does not equal its own canonical form; integers only, at most 2^53-1; ASCII object keys; keys and
signatures as base64url strings; times in whole seconds; no duplicate keys; and a **domain prefix per object type** so a
credential can never be read as a descriptor. (Checked against the existing encoder: duplicate keys collapse, large
integers round, `-0` becomes `0`, key order is by UTF-16 code unit, and there is no Unicode normalisation. The profile
forbids each.)

*Built* (PR #414, `canonical-json.mjs` in `browsermesh-primitives`). The encoder did not move: it is a **new, strict module**,
and core's `canonical.mjs` is untouched, because changing it would break existing signatures. The choices the profile
settled: strings are raw UTF-8 with only `"`, `\` and U+0000..U+001F escaped, as lowercase `\u00xx` (no short escapes, no
`\/`); lone surrogates are rejected; a domain is non-empty printable ASCII (0x21..0x7e); the signed bytes are
`domainSigningBytes = UTF-8(domain) || 0x00 || UTF-8(text)`; nesting is capped at 64; `__proto__` is an ordinary key.
Stable error codes: `unsupported-type`, `number-not-integer`, `negative-zero`, `integer-out-of-range`, `leading-zero`,
`key-not-ascii`, `duplicate-key`, `lone-surrogate`, `whitespace`, `not-canonical`, `depth`, `syntax`, `bad-domain`.
`CanonicalJsonError` extends `Error` with a string `code` (`MeshError.code` is numeric, so it is not reused). The test
vectors live in the repository (`packages/browsermesh-primitives/test/vectors/`, and the realm package's own); the primitives
package publishes `src` only, so they are not in the npm package.

*Built* (PR #420, `browsermesh-realm`). `sig` is a field inside the document and covers the canonical text of the document
without `sig`, under the descriptor domain. A rotation's countersignature uses the domain `rotation-accept/1` and covers the
statement including its own `sig`. The authority-less id is SHA-256 over `domainSigningBytes('browsermesh-realm/authorityless-id/1',
canonical{name, roles, salt})`; that form carries the `guest` role only. Caps: `ttl` 60 s to 30 days, 16 issuers, 512
revoked serials (ascending), a 16 KiB descriptor, a 2 KiB credential, a chain of 8. URLs in `rendezvous` must be `wss` or
`https` (`ws` and `http` only for loopback). Adoption also refuses an epoch regression, a chain regression and a stale held
chain. The ledger has `compact` and `revokedSerials`, and throws `too-many-revoked` rather than drop a serial silently.
The ticket object and its domain are reserved and **not built**.
A reader accepts a descriptor only if it is signed by a root reachable from the pinned id and its `serial` is higher than the
one it holds. A descriptor travels with proofs (5.5), because a credential from an issuer added in serial N fails at a
verifier still on N-1. **Adoption rule (decided):** a descriptor offered by any peer is adopted only after it verifies end
to end against the pinned id and chain and its serial is higher than the held one; size and chain length are capped and the
work is rate-limited per link.

### 5.3 Roles

A role is a list of scope patterns in the notation of `docs/capability-notation.md`, for example `protocol:mcp:open`. A
credential names a role, not a scope list. In `open` mode the descriptor also names the default role for a peer with no
credential (`guest`). Privileged roles always need a credential. Redefining a role widens every credential that names it, so
a host's own allow list (principle 2) is what actually bounds it.

### 5.4 Credential

Issuer-signed: realm id, subject, role, serial, `notBefore`, `notAfter`, `epoch`. The **subject is the pod id** (the hash of
the key), not the raw public key: a link exposes only the pod id (`peerKey`), and the check is
`checkSubject(credential, peerKey)`. Bound to the realm id so it cannot be replayed in another realm. A verifier **clamps**
the lifetime to the realm's `ttl`, so a compromised issuer cannot mint past it. *Built differently:* `notBefore` is not
clamped (it cannot be, without a signing time); the **lifetime** is clamped from it:
`effective notAfter = min(notAfter, notBefore + ttl, issuer.notAfter)`, so backdating `notBefore` only moves the window into
the past. A credential whose epoch is **above** the descriptor's is accepted and flagged `descriptorBehind`. Times are whole
seconds; the registry takes milliseconds, so the exchange multiplies by 1000. Credentials always name a subject; there is
no keyless form in v1.

### 5.5 Realm exchange: where a credential is presented

This is the part the review found missing. Today the wsh listener decides inside the wsh login, from the peer's key alone
and before any mesh frame (default: nobody), so a stranger holding a perfectly valid credential is refused before it can
present it. WebRTC links have no admission check at all.

**Checked against `@johnhenry/wsh` 0.55.0 and `browsermesh-transport`:** the `authorize` callback receives only
`{ podId, fingerprint, publicKey }`, asked after the key's signature verified; wsh's `extensions` (application-defined
control messages) arrive only from connections that have already been authenticated, so they are after `authorize` too; and
`Hello.features` is a pre-authentication, negotiable string list (the host-key nonce already rides there), a possible carrier
for a short realm hint that would let a host refuse a stranger claiming an unknown realm before it takes a slot. That needs
a change in wsh to pass the features to `authorize`, so it is an optional later optimisation, not a v1 requirement.

The design: a realm-enabled node admits an unknown key to a **restricted link** that carries only the realm exchange,
under a short deadline and a cap on how many such links are open. On that link:

1. `realm:hello { id, serial, epoch }` from each side.
2. The side with the higher serial sends its descriptor if the other asks.
3. The prover sends its credential. **There is no extra signature**: the link already proved the peer's key, and the verifier
   checks `credential.subject === the link's proven pod id` (principle 7). *Built:* the credential frame's text may be
   `null`, which asks for the open-mode guest role with no credential.
4. `realm:result { ok | refused: reason }`.

On success the realm grant source (section 7) gains expiring grants for that peer and the link is promoted. A peer that does
not speak realms ignores the unknown message types; the prover treats the missing `realm:result` as "peer does not speak
realms" after a timeout. The proof is one way: a dialler does not learn that the host is a member unless the host also
presents a credential.

**As built** (link admission, merged in #419 and #427, documented in [link-admission.md](link-admission.md); the exchange
itself is merged in #426).

- **How a restricted wsh peer is kept off the mesh endpoint.** Not by a flag the host correlates: the restricted peer is
  granted `endpoint:mesh-admission` instead of `endpoint:mesh`, the host serves a second endpoint of that name, and wsh's own
  capability check does the enforcing. A dialler that finds `mesh` refused by policy falls back to `mesh-admission`. A
  restricted wsh link is not registered: no `peer-up`, not in `peers()`. For WebRTC, `createMeshNode({ admission })` is an
  opt-in gate on inbound connections. `decide` is also asked as the wsh fallback **after** the registry says no
  (`createWshAdmissionAuthorize`).
- **What a held stranger costs.** Not a listening slot until the deadline. Reading `#openSlot`, a waiting half is replaced
  as soon as its peer pairs (the first message, the relay's paired signal), so a held stranger costs a **login and a
  socket**, and `maxRestricted` bounds those. The risk that remains is a burst of strangers larger than the waiting halves
  inside one refill round trip, which the cap does not cover (they are not yet restricted). Defaults, per seam instance:
  `maxRestricted` 8, deadline 10 s, frame cap 16 KiB; keep `maxRestricted` below a relay's waiting-halves-per-id limit.
- **Frames, as built** (#426, merged): `realm:hello`, `realm:need-descriptor`, `realm:descriptor` (at most 16 KiB),
  `realm:credential` (text or `null`) and `realm:result`. Per link at most 16 frames and 2 descriptor replies; the descriptor
  store allows 4 offers and 2 verifications per link and 16 verifications per 60 s overall. `peer-does-not-speak-realms` is
  reported only when no `realm:` frame arrived at all; a stall after one did is `timeout`.
- **Verifier order** (#426, merged): `checkSubject`, the tracker's order check, the registry grant, and only then `tracker.admit`, so
  a stolen credential presented by the wrong key advances nothing; the same serial again is a reconnect and is accepted.
  A guest grant has serial 0 and lasts `min(ttl, guestTtl = 3600 s, validUntil)`. The grant is written **before** the
  result and the promote, or the default access watcher would close the promoted peer at its next re-check.
- **A role must include `mesh:link:connect`**, and the host's policy must admit it: the watcher re-checks it on a promoted
  peer, and a link without it closes at the next access change.
- **Frame size.** The seam's default 16 KiB `maxFrameBytes` silently drops a large descriptor frame (JSON escaping can
  double a descriptor); the visible effect is `unexpected-frame`, not a stall. A host that accepts large descriptors sets
  `maxFrameBytes: MIN_SEAM_FRAME_BYTES`.
- **Dialler.** No transport change is needed. The prover's channel is an adapter over `node.sendTo` and `onIncomingData`;
  register `onIncomingData` **before** `connectToPeer`.
- **Not protected** (also in link-admission.md): a local `connectToPeer()` to a peer whose inbound link is held reuses and
  adopts it; a restricted wsh link's decoder uses the hub's 1 MiB header limit, so memory is `maxRestricted` x 1 MiB;
  outbound links are never restricted; there is no `Hello.features` hint.

### 5.6 Issuing: two paths

The descriptor says which the realm supports.

- **Key-bound issuance (no always-on peer).** The invitee sends its pod id; an issuer signs a credential for that key. Fully
  offline. Suits people, hosts and CLIs.
- **Tickets (with an admitter).** An admitter named in the descriptor redeems a ticket, once, for a credential bound to the
  redeemer's key. The practical route for a web app that cannot know its key before first load. The ticket is delivered as a
  link whose secret is in the URL **fragment**, which browsers do not send to servers.

A page that needs only the guest role needs neither: it joins an `open` realm from the descriptor alone.

### 5.7 Revocation and renewal

Two levers, both eventual.

- **The epoch.** A new descriptor with a higher `epoch` makes a peer stop honouring credentials from older epochs once it
  has adopted that descriptor. This revokes everyone, so every member has to be reissued.
- **Serial revocation.** The descriptor carries a bounded `revoked` list of credential serials, for removing one member.

Every credential expires anyway, so `ttl` is the worst-case latency. A peer that never hears the new descriptor keeps
serving old credentials until `notAfter`. **Renew before expiry:** a member re-presents a fresh credential (a new issuance)
before `notAfter`; the verifier replaces the old grant. The registry's grant source supports this (a grant for the same
(realm, peer, role) replaces the earlier one, so a later `notAfter` extends it), but it does **not** order serials: a stale
credential presented later would replace a newer one, so the realm layer's tracker keeps (realm, issuer, subject, role) to
refuse an older serial or epoch (`stale-serial`, `epoch-too-old`). **Built limit:** renewal by re-linking happens only after
the grant has expired, because `createWshAdmissionAuthorize` asks the registry first and a peer holding a live grant is
admitted as an ordinary link and never put to the exchange. Renewal before expiry therefore goes over the `realm` protocol on the protocol seam (stage 4, merged in #445).

Two more built facts. A newly listed revoked serial is revoked in the registry when the descriptor that lists it is adopted,
and a higher epoch revokes everything below it (`revokeRealmGrants({ realmId, belowEpoch })`). **Removing an issuer does not
revoke its existing grants**: a grant does not record who issued it, so they end at `notAfter`. A rotation's "effective time"
has no enforceable meaning without a signing time, so only that it does not go backwards is checked.

Credentials depend on clocks: the verifier states a skew tolerance (5 minutes) and the credential carries `notBefore`.

### 5.8 Ledger

The issuing side keeps, locally and append-only, one line per credential and ticket: serial, subject, role, expiry, state.
The serials are what `revoked` refers to, so the ledger is part of v1. **One serial space per realm:** `descriptor.revoked`
is a flat list of serials with no issuer, so two issuers that number independently would collide. The rule chosen here: a
realm has **one ledger** (what `meshctl` does: root and issuer on one machine share it), and an operator who must issue from
several machines gives each ledger a **disjoint `serialStart`**. Nothing verifies this; it is the operator's discipline
(`revoked` entries as (issuer, serial) would remove the rule and is listed in section 10).

### 5.9 Open realms

`mode: open` means the descriptor alone is enough to join, at the `guest` role. Two forms:

- a normal realm with a root and issuers, where privileged roles still need credentials; and
- an **authority-less form**: no root key and no issuers; the id is the hash of the **name, roles and a salt only**. The
  rendezvous information (relays, signalling URLs) is carried as **unsigned, replaceable hints** outside the hash, so a dead
  relay no longer orphans the realm. It can never gain privileged roles. Anyone can publish hints, so a joiner treats them
  as candidates, not as authority.

`guest` peers and links are subject to the same caps as strangers in 5.5, and an open realm should publish limits (links,
channels, relay slots) in its descriptor.

### 5.10 Per-realm identities from one seed

One identity per realm means a node has exactly one pod id and so **one node per realm**: `createMeshNode` always created a
fresh identity, so it needed an option to use an existing one, and a host serving two realms is two pods. *Built* (#416):
`createMeshNode({ identityManager, identity: { podId } })` adopts an identity that already exists in the supplied manager. The
adopted identity becomes the manager's **default** (`PeerNode.podId` reads the wallet's default), `label` is ignored when
`identity` is given, and a reload works only if the caller persists the pod id and uses a persistent manager. `lean-node.mjs`
was not changed.

Deriving a realm key: HKDF over the seed with the realm id as context, 32 bytes, wrapped as PKCS#8 and imported as an
Ed25519 key. The review checked this in Node 26: it works, the public key must be read before a non-extractable import, and
`PodIdentity.fromPkcs8` already handles that. It also passes in Chromium, Firefox and WebKit (section 10). *Built* (#415, in
`MeshIdentityManager` and `IdentityWallet`): `createSeed`, `importSeed`, `exportSeed`, `deriveRealmIdentity` and
`createRealmIdentity`, with `derive: false` for the random-key fallback. What it changes:

- `IdentityWallet` had no seed, and `MeshIdentityManager` generates random keys and saved by exporting a private JWK. Built:
  the wallet gains a seed and a derivation step, and the derived identity keys are **non-extractable**. `save()` therefore
  skips identities flagged `derived`: they are **not persisted** and come back from the seed. `save()` does not persist the
  seed either; the app stores the passphrase-sealed export (section 2).
- Existing random identities and external-signer identities cannot be derived.
- The seed is the only secret to back up, so it is **extractable** in the sense that the manager holds plain bytes, and it
  leaves only as `exportSeed(passphrase)`; there is **no unencrypted getter**. The cost, accepted by the owner: anything that
  can run in the page can read the seed while it is loaded. `createSeed` and `importSeed` replace any seed held; identities
  already derived from the old one stay registered.
- A realm id must be a non-empty string without NUL. There is no length cap and no Unicode normalisation (two forms of the
  same text derive different keys). Descriptor ids are base64url hashes, so in practice they are ASCII.
- **Fallback.** If derivation fails in any of Chromium, Firefox or WebKit, v1 ships with independent random keys per
  realm: one backup per realm and the limitation documented. Seed derivation then waits for browser support.
- Derived bytes pass through page memory when imported.
- Derived keys do not hide an IP address or a relay's view of who connects; per-realm identity unlinks keys, not network
  metadata.

**Proposed strings and format** (to be fixed with test vectors, section 10):

- **Derivation.** `info = "browsermesh/realm/v1 identity " + realmId` (UTF-8), HKDF-SHA-256, empty salt (the seed is
  uniformly random, which RFC 5869 permits), 32 bytes out, used as the Ed25519 private-key seed in a fixed 16-byte PKCS#8
  header. This follows the repo's existing convention of a `browsermesh/<thing>/v<n>` domain string, as in
  `SEAL_DOMAIN = 'browsermesh/sealed/v1'` and its HKDF `info`. A different realm id gives an unrelated key.
- **Seed backup.** No new format: `@johnhenry/keyvault`'s `seal(seed, passphrase, { type: 'browsermesh-realm-seed', header })`,
  a self-describing JSON record whose KDF and parameters are authenticated, so they can be raised later
  (`needsUpgrade()`). *Built differently:* the header is `{ fmt: 1, label, createdAt }`, not `v` (keyvault reserves `v`, `t`,
  `kdf`, `iv` and `ct`). A wrong passphrase and a tampered header or record are the same code, `bad_passphrase`
  (`RealmSeedError`); there is no separate "tampered header" error. Today's default is PBKDF2-SHA256 at 600,000 iterations; Argon2id and a WebAuthn PRF secret are
  options keyvault already has, which could later replace the typed passphrase. `browsermesh-core`'s identity export
  already uses keyvault, so the wallet gains no new dependency.
- **First test vector** (seed `00 01 .. 1f`, realm id `realm-test-vector-0000000000000000000000000`): derived seed
  `0da1010425a78f9783e802c9109d3899cdb281f4a1cd5079cec7878a0a8d1235`, public key
  `iAZS2VHtgLy47Huzd17k93TsC8HDwmHZCJNJhX7Ejng` (base64url). Produced by Node 26's WebCrypto, and by Chromium 156 and 159.

**Prior art.**

- *In these repositories:* `@johnhenry/keyvault` (typed, self-describing sealed records; the format above), core's
  passphrase-encrypted identity export (built on it), wsh's `WshKeyStore` (non-extractable keys in IndexedDB for daily use
  and an extractable passphrase-encrypted backup in OPFS, the same split as here, PBKDF2 at 310,000), and the repo's
  HKDF-with-a-domain-string habit (`key-agreement.mjs`, the stealth lookup records, the signalling registration prefix).
- *In general* (from general knowledge; not re-checked for this note): libsodium's `crypto_kdf_derive_from_key`, which is a
  master key plus a context plus a subkey id, the same shape as seed plus realm id; SLIP-0010, the standard for deriving
  Ed25519 keys from a seed, which is hardened-derivation only and heavier than a flat HKDF needs; and WebAuthn, where an
  authenticator derives a separate credential per relying party from one internal secret, which is exactly "one identity
  per realm" with the realm id in the role of the RP id. An Ed25519 private key is itself a 32-byte seed (RFC 8032), so
  using HKDF output directly as that seed is ordinary practice.

## 6. Threat model

| Who or what | What they can do | What stops them |
| --- | --- | --- |
| A visitor reading a page's source | Read the descriptor and any ticket link they were sent | The descriptor holds no secret; tickets are in the fragment, single-use, and bound to a redeemer key on redemption. There is no baked-in bearer credential. |
| A thief of one credential | Nothing without the subject key | The verifier checks the subject against the link's proven key. |
| A compromised issuer | Issue credentials until noticed | The root removes it in a new descriptor; verifiers clamp lifetime and `notBefore`; credentials die at `notAfter`. |
| A compromised current root | Everything | Nothing: the realm is over. Offline storage only. |
| A leaked retired root key | Sign a competing successor | First-seen rule limits it for verifiers that saw the real rotation; a fresh page may be fooled (5.1). |
| A malicious peer announcing a high serial | Waste verification work | A peer verifies only a serial higher than its own, caps chain and descriptor size, and rate-limits per link. |
| Replay of an old descriptor | Resurrect a removed issuer | Monotonic `serial`; a fresh page starts from its baked snapshot, so ship `validUntil`. |
| Replay across realms | Use a credential in another realm | Credentials name the realm id. |
| A member with a valid role asking for more | Reach beyond the role | Each host's realm policy and allow list (principle 2). |
| Strangers and guests holding links | Exhaust links, channels, relay slots | Caps and deadlines on restricted links; published limits for open realms. |
| A very slow or skewed clock | Extend or shorten validity | Skew tolerance; `notBefore`; verifier-side lifetime clamp. |
| A relay or signalling server | Drop, delay, observe metadata | Links are sealed and authenticated to keys. Membership is also visible to any peer that asks: presenting a credential reveals the realm and the credential serial. |

## 7. Where it plugs in

- **A new grant source in `PeerRegistry`**, not writes into a peer's ACL template. Review experiments against the real
  `MeshACL` found five failures when realm grants share the operator's slot: a renewal with a later expiry is ignored; an
  operator's permanent grant expires with the realm's; an expired realm wildcard blocks a permanent narrow operator grant; a
  realm revocation deletes the operator's identical grant; and a restored registry honours an expired grant again. The
  realm source is therefore **unioned with the operator's grants** in `checkAccess`, with its own expiry and epoch, never
  persisted, and it feeds the existing access-change events so open links re-check. *Built* (#417), and **keyed differently
  from the first design**: by (realm, peer, role), not (realm, serial), so a renewal replaces the earlier grant. The
  registry therefore does not order serials; the realm layer must refuse an older serial or epoch (5.7). `notAfter` is in
  milliseconds on the registry's clock, while credentials use whole seconds. The only removal by epoch is
  `belowEpoch`; refusing an older-epoch credential at grant time is the realm layer's job. Events: `realm-granted`,
  `realm-replaced`, `realm-revoked`, `realm-policy` and `expired`.
- **Link admission** (5.5) needed a hook in `browsermesh-transport` for wsh, and a new admission gate for WebRTC links,
  which had none. Built (#419, #427): a change to existing packages, not only a new one.
- **`createMeshNode`** gains a `realm` option (descriptor, credential) and an `identity` option (5.10). `identity` is built
  (#416); `realm` is stage 4, merged in #445. Note it currently requires an already-built signalling transport, not a URL.
- **Signalling server.** Checked in `browsermesh-servers/signaling`: its authenticated mode proves only that a pod id is the
  hash of the key that signed a per-connection nonce bound to the server's own origin. It has no rooms, realms or
  membership, so it cannot carry or enforce realm membership; the design never assumes it can.
- **Open links** already re-check on access changes (wsh, protocol channels, egress, the relay host), so expiry and epoch
  changes close them. With renewal (5.7) members are not hard-closed at `notAfter`. **Restricted links are not covered:**
  they have no registry entry, so they are bounded by the deadline alone; and the realm layer must write the registry grant
  **before** promoting, because the default `watchWshAccess` closes a promoted peer the registry does not allow.
- **`browsermesh-realm` depends on `browsermesh-primitives` only.** The canonical encoder is a new strict module there
  (core's own is internal, not exported and left alone), and the registry is taken duck-typed. Depending on
  `browsermesh-apps` would create a second circular pair beside core and apps. The peer range on primitives is `>=0.7.0` on
  `main` and must be `>=0.8.0`, the first release that exports `canonicalJson`; that change merged with #426. The package is
  published to npm as 0.1.0, a preview (the first-release changeset flipped `private`).
- **meshctl** (section 8) is the operator and member front end. It does not use `createMeshNode`, so stage 3 does not cover it.

## 8. CLI sketch (meshctl)

One JSON document per command, as everywhere in meshctl, with `--pretty` for people.

```
# admin (holds the root, or an issuer key)
meshctl realm create <name> [--mode open|invite] [--admitter <host>]
meshctl realm issue  <realm> --role member [--pod-id <id> | --public-key <key>] [--ttl 7d]   # key-bound; subject = pod id
meshctl realm invite <realm> --role member [--uses 1] [--ttl 24h]        # ticket link (needs an admitter; NOT built)
meshctl realm revoke <realm> [--serial <n>]                              # one credential, or bump the epoch (needs the ROOT)
meshctl realm rotate <realm>
meshctl realm ledger <realm>

# member
meshctl realm join   <descriptor|link>
meshctl realm ls
meshctl realm inspect <realm>          # descriptor and the peers linked from THIS node
meshctl realm export <realm> [--descriptor]
```

`inspect` can only show the peers currently linked from this node; it says so. There is no `leave`: with no roster it has no
protocol meaning, so a member simply deletes its profile.

**As built** (PR #424, checked against that branch). The commands above exist, except `invite`, which only answers
`EREALM_NOT_IMPLEMENTED` (no tickets, no admitters). Where it differs from the sketch:

- **Who signs what.** Descriptors are signed by the **root** only, so `revoke` (a new descriptor, serial or epoch) and
  `rotate` need the root; only `issue` is issuer-only. The root cannot stay fully cold for a serial revocation: it can be off
  the issuing machine (`issue` keeps working, `revoke` and `rotate` answer `EREALM_NO_KEY`), but it has to come back for
  those. Today that means moving `root.key.json` by hand.
- **Subject.** `issue` takes `--pod-id <id>` or `--public-key <key>` (converted to its pod id); `--key` is refused. (An
  earlier draft of the branch took the raw public key; the credential subject is the pod id, section 13.)
- **Issuers.** `create` makes one issuer with a one-year `--issuer-ttl`. Nothing can add, renew or replace an issuer, and
  there is no `--valid-until`; both need a root-signed descriptor change (section 10).
- **Join.** `join` without `--id` trusts the first descriptor it is given (it reports `pinned: computed`). A fresh member
  cannot join with a credential in one step, since the credential is bound to a key that does not exist yet: `join`, send
  the printed pod id, `issue`, `join` again with `--credential`.
- **Other choices.** One passphrase seals both keys of a realm (read from an environment variable or a mode-0600 file,
  never argv); keys are sealed with keyvault type `browsermesh-realm-root`; roles default to `guest` and `member`; the realm
  argument is an id, an id prefix of six or more characters, or a name; issued credentials are stored so
  `export --credential` re-sends them; `--ttl` above the realm's ttl is refused, not clamped; the layout is
  `<realm-dir>/<id>/{descriptor.json, ledger.json, root.key.json, issuer.key.json, issued/, profile/}`; a rotation that
  stops half way is recovered by the next command.
- **Not done:** seed-derived per-realm identities (v1 makes an independent random key per realm in `profile/`), tickets and
  admitters, live peer listing in `inspect`, passphrase rotation, a separate issuer passphrase, and a one-step cold-root
  workflow.

meshctl on `main` stores **one plaintext identity file per profile** (mode 0600) and says it has no multi-identity UX. Realms
need per-realm identity selection, and a root key that is kept offline and stored encrypted (the identity manager already
has a passphrase export); PR #424 adds both, a per-realm `profile/` and sealed key files. meshctl's README says it has no more authority than any granted peer and is not an admin API;
holding a realm key changes that, so the admin half is framed as **local key custody and offline signing** that grants
nothing on anyone else's host.

## 9. Not in this design

Federation (one realm trusting another; `extensions` is reserved), a member roster, network-wide encryption keys (group keys
in `core` can attach to an epoch later), services as first-class realm objects (they stay with `describe` and discovery), a
TUI, server-side membership enforcement, and a keyless credential.

## 10. Open questions

Settled by the owner on 2026-11-26 (now in section 2): seed extractable with a passphrase export; HKDF-SHA-256 derivation
and an encrypted-file backup; derivation relied on only if it passes in Chromium, Firefox and WebKit; independent per-realm
keys as the fallback; adoption of a descriptor only after verification.

Settled by reading the code (5.5 and 7): the wsh login cannot carry realm data to `authorize` today, and the signalling
server has no membership concept.

Settled by running it (2026-11-26): **seed derivation works in all three browsers.** A browser spec
(`tests/browser/realm-derivation.spec.mjs`, pull request #407) derives the key from a fixed seed and asserts the derived
bytes, the public key and the deterministic signature against the vector pinned from Node 26, and that the kept key is
non-extractable and refuses export. The repository's CI ran it in Chromium, Firefox and WebKit and it passed in each. So v1
takes derivation, not the fallback, and the fallback stays only as a guard if a later browser release regresses. Caveat: the
check ran against the browser builds CI uses on that day, and not on mobile Safari or any other engine.

Settled by building (2026-11-26, PRs #414 to #420, #426 and #445 merged, #424 in an open PR):

- The exact strings and record shape of 5.10 are fixed in code, with the first vector pinned in the wallet's tests (#415);
  the seed header is `{ fmt: 1, label, createdAt }`.
- Who persists the seed: the app, as the passphrase-sealed export (section 2).
- The canonical profile's choices and error codes (5.2), and the credential subject (the pod id, section 13).
- The serial rule (5.8): one ledger per realm, or disjoint `serialStart` ranges per issuer.

Still open:

1. **A command to add, renew or replace an issuer**, and `--valid-until`. Every credential needs an issuer, and `create`
   makes one with a one-year lifetime, so after a year nothing can be issued without hand-editing. It needs a root-signed
   descriptor change, so it is a root operation (section 8).
2. **`descriptor.revoked` has no issuer.** The rule in 5.8 (one ledger, or disjoint `serialStart`) is a convention nobody
   verifies. Open: whether to make `revoked` entries (issuer, serial) instead.
3. **A rotation's "effective time" has no enforceable meaning** without a signing time; only monotonicity is checked (5.7).
   Open: drop the field, or add a signed time with its own clock-skew rules.
4. **A wsh change for a pre-authentication realm hint** (5.5). Deferred, and tracked as johnhenry/wsh#274 with a trigger
   (slot exhaustion by strangers seen in tests or real use), not part of this plan. The built cost of a held stranger is a
   login and a socket, bounded by `maxRestricted`, which lowers the urgency.
5. **Renewal by re-link only works after a grant expires** (5.7). Renewal before expiry is the `realm` protocol (merged in
   #445); an epoch bump cannot renew in place (the peer re-links and presents again). Open: whether a granted peer should
   ever be sent through the exchange on re-link.
6. **Removing an issuer does not revoke the grants it issued** (5.7). Open: record the issuer on the grant, or accept
   `notAfter` as the bound.
7. **Seed management in meshctl** (today one random key per realm), tickets and admitters, live peer listing, passphrase
   rotation and a one-step cold-root workflow (section 8).

## 11. Staged order

1. **Done.** This note, reviewed (PR #406; revised after the build).
2. **Prerequisites in existing packages, each with its own tests:**
   - **Done (merged):** the canonical encoder in primitives (#414); wallet seed support, with derivation proven in Chromium,
     Firefox and WebKit first (#407, #415); `createMeshNode({ identity })` (#416); the realm grant source in `PeerRegistry`
     (#417); link admission hooks for wsh and WebRTC (#419), fail-closed with an older transport (#427).
   - **Done (merged, #441):** the seam's `send` never rejects on a closed link.
   - **Done (merged, #445):** the `realm` option of `createMeshNode` (stage 4 below).
3. **`browsermesh-realm`:** descriptor, rotation, roles, credential, ledger, with test vectors: **done (merged, #420;
   published as 0.1.0 after the first-release PR)**. The realm exchange: **done (merged, #426)**.
4. **The wiring and the meshctl commands.** `createMeshNode({ realm })`, a realm policy API on the node, an automatic prover
   after `connectToPeer`, and renewal over a `realm` protocol on the protocol seam: **done (merged, #445)**. It builds the store and
   verifier inside `createMeshNode` with the node's registry and persists the descriptor through `store.export()`. API as
   merged: `createMeshNode({ realm: { pinnedId, descriptor?, credential?, policy, guestTtl?, limits?,
   persist?: { load, save }, autoRenew?: { credentialProvider, beforeSeconds = 300 }, onEvent?, timeoutMs = 5000, admission?,
   loadRealmPackage? } })`. `realm` together with `admission` throws; the realm's `decide` is `restrict`, except `allow` for
   a peer the registry already lets link (`mesh:link:connect`). `node.realm` is `{ store, verifier, policy, status(),
   setCredential(), present(), renew() }`. Renewal is authorised by a non-empty
   `registry.listRealmGrants({ realmId, peerKey })`, which adds no scope (if the app attached its own `mesh-protocols` it
   also needs `protocol:realm:open`). A failing `persist.load` aborts boot; `persist.save` errors are swallowed and logged;
   the baked descriptor is offered after the persisted one, so the higher serial wins; `renew` returns `{ ok: false }`
   rather than throwing. The `meshctl realm` commands:
   **in PR #424**. Example 26: **in PR #442**.
5. **Real-peer and real-browser tests:** invite and open modes, epoch and serial revocation, renewal before expiry, rotation
   and the fork rule, a replayed descriptor, a host policy that refuses an `egress:` role scope, and strangers capped on a
   restricted link. **Partly done:** #426 runs the exchange over a real wsh link in-process (open mode, a credential, a
   stranger, revocation by epoch); real WebRTC and real browsers: **not started**.
6. **Optional later, not started:** tickets with an admitter, server-side filtering, federation, synchronising a realm across
   several nodes.

## 12. What the reverse review changed

Three blockers: a credential has no place to be presented (5.5), `PeerRegistry` cannot carry realm grants as it stands (7),
and a node cannot keep an identity across a reload (5.10). Also: roles could silently open wildcard egress or ingress
(principle 2); the proof signature was redundant on a verified link and is gone; the rotation chain was claimed to help
against root compromise and does not (5.1); canonical JSON needed a strict profile (5.2); the encoder is not importable from
core, so realm depends on primitives only (7); a bounded `revoked` list and renew-before-expiry were added (5.7);
verifiers clamp lifetime (5.4); and the authority-less id no longer hashes rendezvous URLs (5.9). It also recommended cutting
the keyless credential, which the owner accepted, and deferring rotation and seed derivation, which the owner chose to keep.

## 13. What the implementation changed

Where the build departed from the first design, or settled something the first design left open. None of these changes an
owner decision in section 2; where a built detail narrows a decision, it says so.

- **The credential subject is the pod id**, not the raw public key. A link exposes only `peerKey`, the pod id, and the
  exchange checks `checkSubject(credential, peerKey)`. (An earlier collected correction said "public key"; it was wrong, and
  meshctl's `issue` now takes `--pod-id` or `--public-key` and converts.)
- **The `mesh-admission` endpoint instead of a flag.** A restricted wsh peer is granted `endpoint:mesh-admission` rather
  than `endpoint:mesh`, so wsh's own capability check keeps it off the mesh endpoint (5.5).
- **Held strangers cost a login and a socket, not a listening slot** (5.5). The design said slots would be exhausted.
- **`realm:credential` may carry `null`**, which asks for the open-mode guest role with no credential.
- **The `realm` protocol for renewal.** The exchange only runs on a restricted link, and a peer with a live grant never
  reaches it, so renewal before expiry goes over a protocol on the protocol seam (stage 4, merged in #445).
- **A role must include `mesh:link:connect`**, or the default access watcher closes a promoted link at the next access change.
- **The seam's `send` never rejects on a closed link** (PR #441, merged); it resolves
  `false`, so a handler needs no catch for that case.
- **Fail-closed negotiation.** `WshPeerLinks` calls `authorize(peer, { restricted: true })` and sets
  `WshPeerLinks.supportsRestrictedAdmission`; `createWshAdmissionAuthorize` returns the restricted verdict only to a caller
  that passed that option, and a one-argument call (an older transport) is refused with `restricted-unsupported` (#427).
- **The canonical encoder did not move**; a new strict module was added beside core's (5.2).
- **The registry grant is keyed by (realm, peer, role)**, not (realm, serial), so it does not order serials and the realm
  layer's tracker must (5.7, section 7).
- **The lifetime is clamped, not `notBefore`** (5.4); the seed header uses `fmt`, not `v` (5.10); derived identities are not
  persisted by `save()` (5.10).
- **Descriptors are root-signed only.** Serial revocation and epoch bumps need the root; only `issue` is issuer-only (8).
- **A hello can be lost over WebRTC** (#445). A data channel drops frames sent before the peer has a session or has wired
  its handler (about one run in fifteen stalled). The verifier now answers a peer's hello with its own again, and the prover
  says hello again on seeing the verifier's; identical repeats are ignored and a different second hello is still refused. This
  touches #426's exchange code.
- **Raw `onIncomingData` subscribers must call `decodeWireData`**; the audited list in `wire-plumbing.test.mjs` gained
  `realm-channel.mjs`.
- **Protocol channels are keyed by name.** A late close notice from the host would kill the next `realm` channel to the same
  peer, so renewal waits for the host's close (at most 500 ms) and is serialised per peer.
- **An epoch bump cannot renew in place.** It revokes the grant and closes the realm channel, so a descriptor update that
  raises the epoch cannot also renew: the peer re-links and presents again. A serial bump at the same epoch renews fine.
- **A granted peer skips the exchange on re-link**, so the automatic presentation times out harmlessly: the link is left
  alone and the previous success is kept.
