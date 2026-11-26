# Realms: a portable way to say "this is the mesh, and this is who may be in it"

Status: **proposal, nothing built.** Written 2026-11-26 against `main`; revised the same day after a reverse review that
checked every claim below against the source. This page is the design to review before any code. Section 2 is what the
owner has decided, section 10 what is still open, and section 12 what the review changed.

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
| **Credential** | An issuer-signed statement that one key has a role in this realm until a time. |
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
   anything under `matchScope`) is rejected at parse.
3. **Anything baked into a page is public.** The design assumes every visitor can read it.
4. **Enforcement is at the peers.** Relays and signalling servers stay dumb rendezvous.
5. **No roster.** A peer proves it is a member when it links; nobody keeps a list.
6. **Browser-usable.** The descriptor lists only what a page can use: signalling URLs, wsh relays, ICE and TURN, bootstrap
   hosts. No mDNS, QUIC or raw TCP.
7. **Direct links only.** A credential is honoured only on a direct link that proved its peer's key. Routed paths and
   unbound WebRTC links are refused.

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

Issuer-signed: realm id, subject key, role, serial, `notBefore`, `notAfter`, `epoch`. Bound to the realm id so it cannot be
replayed in another realm. A verifier **clamps** the lifetime to the realm's `ttl`, so a compromised issuer cannot mint
past it or backdate `notBefore`. Credentials always name a subject key; there is no keyless form in v1.

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
under a short deadline and a cap on how many such links are open (wsh's `listenSlots` default is small, so held strangers
are otherwise a denial-of-service surface). On that link:

1. `realm:hello { id, serial, epoch }` from each side.
2. The side with the higher serial sends its descriptor if the other asks.
3. The prover sends its credential. **There is no extra signature**: the link already proved the peer's key, and the verifier
   checks `credential.subject === the link's proven key` (principle 7).
4. `realm:result { ok | refused: reason }`.

On success the realm grant source (section 7) gains expiring grants for that peer and the link is promoted. A peer that does
not speak realms ignores the unknown message types; the prover treats the missing `realm:result` as "peer does not speak
realms" after a timeout. The proof is one way: a dialler does not learn that the host is a member unless the host also
presents a credential.

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
before `notAfter`; the verifier replaces the old grant. This depends on the grant source in section 7 supporting renewal,
which `PeerRegistry` does not today.

Credentials depend on clocks: the verifier states a skew tolerance (5 minutes) and the credential carries `notBefore`.

### 5.8 Ledger

The issuing side keeps, locally and append-only, one line per credential and ticket: serial, subject, role, expiry, state.
The serials are what `revoked` refers to, so the ledger is part of v1.

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

One identity per realm means a node has exactly one pod id and so **one node per realm**: `createMeshNode` today always
creates a fresh identity, so it needs an option to use an existing one, and a host serving two realms is two pods.

Deriving a realm key: HKDF over the seed with the realm id as context, 32 bytes, wrapped as PKCS#8 and imported as an
Ed25519 key. The review checked this in Node 26: it works, the public key must be read before a non-extractable import, and
`PodIdentity.fromPkcs8` already handles that. **Not yet checked in a browser.** What it changes:

- `IdentityWallet` has no seed today, and `MeshIdentityManager` generates random keys and saves by exporting a private JWK,
  so it needs extractable keys. The wallet gains a seed and a derivation step.
- Existing random identities and external-signer identities cannot be derived.
- The seed is the only secret to back up, so it is **extractable**, and exported only under a passphrase (the identity
  manager's passphrase export is the base). The cost, accepted by the owner: anything that can run in the page can read the
  seed while it is loaded.
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
  (`needsUpgrade()`). Today's default is PBKDF2-SHA256 at 600,000 iterations; Argon2id and a WebAuthn PRF secret are
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
  realm source is therefore **unioned with the operator's grants** in `checkAccess`, keyed by (realm, credential serial),
  with its own expiry and epoch, never persisted, and it feeds the existing access-change events so open links re-check.
- **Link admission** (5.5) needs a hook in `browsermesh-transport` for wsh, and a new admission gate for WebRTC links,
  which has none. This is a change to existing packages, not only a new one.
- **`createMeshNode`** gains a `realm` option (descriptor, credential) and an `identity` option (5.10). Note it currently
  requires an already-built signalling transport, not a URL.
- **Signalling server.** Checked in `browsermesh-servers/signaling`: its authenticated mode proves only that a pod id is the
  hash of the key that signed a per-connection nonce bound to the server's own origin. It has no rooms, realms or
  membership, so it cannot carry or enforce realm membership; the design never assumes it can.
- **Open links** already re-check on access changes (wsh, protocol channels, egress, the relay host), so expiry and epoch
  changes close them. With renewal (5.7) members are not hard-closed at `notAfter`.
- **`browsermesh-realm` depends on `browsermesh-primitives` only.** The canonical encoder moves there (it is internal to
  core today and not exported), and the registry is taken duck-typed. Depending on `browsermesh-apps` would create a second
  circular pair beside core and apps.
- **meshctl** (section 8) is the operator and member front end. It does not use `createMeshNode`, so stage 3 does not cover it.

## 8. CLI sketch (meshctl)

One JSON document per command, as everywhere in meshctl, with `--pretty` for people.

```
# admin (holds the root, or an issuer key)
meshctl realm create <name> [--mode open|invite] [--admitter <host>]
meshctl realm issue  <realm> --role member [--key <podId>] [--ttl 7d]    # key-bound
meshctl realm invite <realm> --role member [--uses 1] [--ttl 24h]        # ticket link (needs an admitter)
meshctl realm revoke <realm> [--serial <n>]                              # one credential, or bump the epoch
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

meshctl today stores **one plaintext identity file per profile** (mode 0600) and says it has no multi-identity UX. Realms
need per-realm identity selection, and a root key that is kept offline and stored encrypted (the identity manager already
has a passphrase export). meshctl's README says it has no more authority than any granted peer and is not an admin API;
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

Still open:

1. **The browser check.** Run as a spike on 2026-11-26. **Chromium 156 and 159 pass** and match Node 26 exactly (derived
   bytes, public key and signature; the key is non-extractable and refuses export). **Firefox and WebKit could not be
   launched on the author's machine** (a NixOS box with only Chromium's libraries), so nothing is known about them yet. The
   same check is now a browser spec in a separate pull request (#407) that the repository's CI runs in all three browsers;
   its result closes this item, and a failure in either decides the fallback.
2. **The exact strings and record shape.** Proposed in 5.10 from the prior art above, with the first vector. Closed when the
   wallet code lands and the vector is pinned in its tests.
3. **A wsh change for a pre-authentication realm hint** (5.5). Deferred, and tracked as johnhenry/wsh#274 with a trigger
   (slot exhaustion by strangers seen in tests or real use), not part of this plan.

## 11. Staged order

1. This note, reviewed.
2. Prerequisites in existing packages, each with its own tests: a realm grant source in `PeerRegistry`; link admission hooks
   for wsh and WebRTC; `createMeshNode` options for an existing identity and a realm; the canonical encoder in primitives;
   wallet seed support, **proven in real browsers first**.
3. `browsermesh-realm`: descriptor, rotation, roles, credential, realm exchange, ledger, with test vectors.
4. The meshctl commands.
5. Real-peer and real-browser tests: invite and open modes, epoch and serial revocation, renewal before expiry, rotation and
   the fork rule, a replayed descriptor, a host policy that refuses an `egress:` role scope, and strangers capped on a
   restricted link.
6. Optional later: tickets with an admitter, server-side filtering, federation.

## 12. What the reverse review changed

Three blockers: a credential has no place to be presented (5.5), `PeerRegistry` cannot carry realm grants as it stands (7),
and a node cannot keep an identity across a reload (5.10). Also: roles could silently open wildcard egress or ingress
(principle 2); the proof signature was redundant on a verified link and is gone; the rotation chain was claimed to help
against root compromise and does not (5.1); canonical JSON needed a strict profile (5.2); the encoder is not importable from
core, so realm depends on primitives only (7); a bounded `revoked` list and renew-before-expiry were added (5.7);
verifiers clamp lifetime (5.4); and the authority-less id no longer hashes rendezvous URLs (5.9). It also recommended cutting
the keyless credential, which the owner accepted, and deferring rotation and seed derivation, which the owner chose to keep.
