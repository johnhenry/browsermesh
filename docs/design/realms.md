# Realms: a portable way to say "this is the mesh, and this is who may be in it"

Status: **proposal, nothing built.** Written 2026-11-26 against `main`. This page is the design to review before any code;
it records what the owner has decided, what is only a leaning (marked **Leaning**), and what is open (section 10).

## 1. The problem

A web app, a CLI or a host that wants to join a mesh today needs a pile of separate things: a signalling URL, a wsh relay,
ICE and TURN settings, bootstrap hosts, and, afterwards, grants on every host it will talk to. There is no single object
that says "this is the mesh" and nothing that says "this key may be in it". An app author who wants to ship an app that
joins one particular mesh has to assemble and bake in that pile by hand, and has no way to tell a stranger's pod from a
member's.

What exists and is reused here (read from the source and `docs/security.md`, not exhaustively traced):

- **Identity.** A pod id is the hash of its Ed25519 key. Links are authenticated to a verified peer key.
- **Authorisation.** `PeerRegistry` grants are default-deny, per peer key, with wildcards and expiry
  (`protocol:<name>:open`, `mesh:link:connect`, `egress:...`). The link authorisers (`createWshAuthorizer`) and the
  protocol seam consult it.
- **Capability tokens** in `browsermesh-core`: issuer-signed, bound to a holder, narrowable by delegation, with expiry.
- **Peer and host descriptions**: `meshctl host describe` already returns a host's lane, verbs and capabilities.

What is missing is the realm itself: its identity, its rendezvous information, its policy, and the credentials that say
who belongs.

## 2. Decisions already made (owner, 2026-11-26)

- Realms are **both public and private**.
- An always-on peer is **optional, and the realm defines whether it has one**.
- **Eventual revocation is acceptable**, especially where there is no always-on peer.
- The name is **realm**. ("Network" is taken: `VirtualNetwork` in `browsermesh-netway` is something else.)
- **One identity per realm**, not one global identity, so realms cannot correlate a user across each other.
- The **authority-less open realm** exists as its own form (section 5.9).
- The code lives in a **new package, `browsermesh-realm`**, peer-depending on core and apps; meshctl's commands call it.
- The default credential **`ttl` is 7 days** (a realm may set its own in the descriptor), which is also the default
  worst-case revocation delay.
- The verifier's **clock-skew tolerance is 5 minutes**, configurable per verifier.
- Per-realm keys are **derived from one seed**, so a single backup recovers every realm identity while realms still cannot
  link the keys to each other. The wallet gains a key-derivation step (a different derivation context per realm id).
- Descriptors and credentials are **canonical JSON with Ed25519, with test vectors**, using `browsermesh-core`'s canonical
  encoder, so wsh or another language can verify them later.

## 3. Terms

| Term | Meaning |
| --- | --- |
| **Realm** | A membership and policy domain: an id, a root authority, rendezvous information and a set of roles. Not a network in the netway sense; it carries no packets. |
| **Descriptor** | The signed, public document that describes a realm. Safe to ship in a web app. |
| **Root** | The realm's root key. Kept offline; signs the descriptor and delegates to issuers. |
| **Issuer** | A key the root has delegated to, used day to day to sign credentials. |
| **Role** | A named bundle of scopes (`guest`, `member`, `host`, `relay`, `admin`), defined in the descriptor. |
| **Credential** | An issuer-signed statement that a key, or any holder (section 5.6), has a role in this realm until a time. |
| **Ticket** | A single- or N-use token redeemed once for a credential bound to the redeemer's own key. |
| **Proof** | What a peer presents when it links: its credential, and a signature over the link's challenge. |
| **Ledger** | The issuer's local record of every credential and ticket issued. |

## 4. Principles

1. **Keep five questions apart**: discovery (finding peers), authentication (who is this key), authorisation (what may it
   do), connectivity (a working path), membership (is it in the realm). A realm answers only the last, and feeds the
   third.
2. **Local policy always wins.** A realm credential grants *eligibility*; each host's own registry and operator decide.
   Operator-owned limits (egress allow lists and `allowPrivate`, ingress mappings, hosted-pod grants) are never overridden
   by a role. No role may silently carry a wildcard that a provider requires an explicit acknowledgement for.
3. **Anything baked into a page is public.** The design assumes every visitor can read it.
4. **Enforcement is at the peers.** A realm is a source of registry grants. Relays and signalling servers stay dumb
   rendezvous; they may later add an optional filter, but nothing depends on it.
5. **No roster.** A peer proves it is a member when it links. Nobody keeps, or can be asked for, a list of members.
6. **Browser-usable.** The descriptor lists only what a browser page can use: signalling URLs, wsh relays, ICE and TURN,
   bootstrap hosts. No mDNS, QUIC or raw TCP.

## 5. The objects

### 5.1 Realm id, root and rotation

The id is derived from the **first** root key (the genesis key), not the current one, so that rotating the root does not
change the id and break every app that pinned it. A rotation is a statement, signed by the outgoing root, naming the
successor and a serial. Apps pin the id; they accept any descriptor whose rotation chain leads from the genesis key to the
current root.

### 5.2 Descriptor

Fields (names are a sketch): `v`, `id`, `name`, `serial` (monotonic), `epoch` (section 5.7), `mode` (`open` or `invite`),
`root` (current key and rotation chain), `issuers` (keys the root delegated to, each with its own expiry), `roles`,
`rendezvous` (signalling, wsh relays, ICE and TURN, bootstrap hosts), `admitters` (hosts that redeem tickets; may be
empty), `updateUrl` (optional), `ttl` (default credential lifetime), `labels` (discovery metadata only, never used for
authorisation), `extensions`. Signed by the root.

A reader accepts a descriptor only if it is signed by a root reachable from the pinned id and its `serial` is not lower
than the one it already holds. That blocks replaying an old descriptor to resurrect a revoked issuer.

### 5.3 Roles

A role is a list of scope templates in the notation of `docs/capability-notation.md`, for example `protocol:mcp:open` or
`objects:app:call`. A credential names a role, not a scope list, so apps do not bake scope strings in and a realm can
change what a role means by publishing a new descriptor. In `open` mode the descriptor also names the default role for a
peer with no credential (`guest`). Privileged roles always need a credential.

### 5.4 Credential

Issuer-signed: realm id, subject (a key, or "any holder" for a keyless credential, section 5.6), role, serial, `notBefore`,
`notAfter`, `epoch`. Bound to the realm id so it cannot be replayed in another realm. Verification yields **expiring
registry grants** for the proving peer; nothing else in the enforcement path changes.

### 5.5 Proof

At link time a peer sends its credential and a signature, by its own key, over a challenge bound to the link's verified
key. A peer also announces the `serial` of the descriptor it holds; a peer that sees a higher, root-signed descriptor
adopts it. This is how a running app learns a new `epoch` with no always-on peer.

### 5.6 Issuing: two paths, and a fallback

The descriptor says which the realm supports.

- **Key-bound issuance (no always-on peer).** The invitee generates its identity and sends its pod id; an issuer signs a
  credential for that key. Fully offline. Suits people, hosts and CLIs.
- **Tickets (with an admitter).** An admitter named in the descriptor redeems a ticket, once, for a credential bound to the
  redeemer's key. This is the practical route for a web app, which cannot know its key before first load. A ticket is
  delivered as a link whose secret is in the URL **fragment**, which browsers do not send to servers.
- **Keyless credential (fallback).** For a baked-in app with no admitter: a credential whose subject is "any holder", at a
  low role, with a short `notAfter`. **It is a bearer secret**: anyone who can read the page can use it. The README of any
  realm tool must say so. Rotating it means shipping a new build.

### 5.7 Revocation: epoch and expiry

There is no revocation list. A revocation is a new descriptor with a higher `epoch`; credentials from an older epoch stop
being honoured by a peer once it has adopted that descriptor, and every credential expires anyway. The credential lifetime
(`ttl`) is therefore the worst-case revocation latency, and the realm chooses it. A short `ttl` needs a way to renew;
renewal is a new issuance (5.6).

Credentials depend on clocks. The verifier states a skew tolerance and the credential carries `notBefore`.

### 5.8 Ledger

The issuing side keeps, locally and append-only, one line per credential and ticket: serial, subject (or "any holder"),
role, expiry, state. You cannot revoke or audit what you cannot list, so this is part of v1.

### 5.9 Open realms

`mode: open` means the descriptor alone is enough to join, at the `guest` role. Two forms:

- a normal realm with a root and issuers, where privileged roles still need credentials; and
- an authority-less form (decided, 2026-11-26): `issuers` empty and no root key, whose id is the hash of the immutable
  descriptor. It can never be updated or rotated and has no privileged roles. Useful for "public room" apps.

## 6. Threat model

| Who or what | What they can do | What stops them |
| --- | --- | --- |
| A visitor reading a page's source | Use any baked-in credential | The keyless credential is the only secret baked in; it is low-role and short-lived, and documented as a bearer secret. Descriptors hold no secret. |
| A thief of one bound credential | Nothing without the bound key | The proof signs a challenge with the subject key. |
| A compromised issuer | Issue credentials until noticed | The root removes the issuer in a new descriptor (higher `serial`); credentials die at `notAfter`. |
| A compromised root | Everything | Offline storage; rotation chain; out of scope beyond that. |
| A malicious relay or signalling server | Drop, delay, observe metadata | Links are sealed and authenticated to keys; the realm adds nothing it can read. |
| Replay of an old descriptor | Resurrect a removed issuer | Monotonic `serial`; peers adopt only higher. |
| Replay across realms | Use a credential in another realm | Credentials name the realm id. |
| A peer with a valid role asking for more | Reach beyond the role | Principle 2: local policy and the role's scope list bound it. |
| A very slow or skewed clock | Extend or shorten validity | Skew tolerance; `notBefore`. |

## 7. Where it plugs in

- **`PeerRegistry`** gains a realm-backed grant source: verifying a credential adds expiring grants. To verify before
  building: registry grants support expiry as `docs/security.md` says, and how existing revocation state behaves.
- **Link authorisers** are unchanged: they already ask the registry.
- **`createMeshNode`** gains a `realm` option (descriptor, optional credential) that fills in the signalling, relay and
  ICE settings and wires the grant source.
- **meshctl** (section 8) is the operator and member front end.

## 8. CLI sketch (meshctl)

One JSON document per command, as everywhere in meshctl, with `--pretty` for people.

```
# admin (holds the root, or an issuer key)
meshctl realm create <name> [--mode open|invite] [--admitter <host>]
meshctl realm issue  <realm> --role member [--key <podId>] [--ttl 7d]    # key-bound
meshctl realm invite <realm> --role member [--uses 1] [--ttl 24h]        # ticket link
meshctl realm revoke <realm>                                             # bump the epoch
meshctl realm ledger <realm>

# member
meshctl realm join   <descriptor|link>
meshctl realm ls
meshctl realm inspect <realm>          # descriptor and the peers linked from THIS node
meshctl realm leave  <realm>

# for apps
meshctl realm export <realm> [--descriptor | --credential]
```

`inspect` can only show the peers currently linked from this node; it must say so, since no one holds a roster.

meshctl's README says it has no more authority than any granted peer and is not an admin API. Holding a realm key changes
that, so the admin half is framed as **local key custody and offline signing**: it grants nothing on anyone else's host.

## 9. Not in this design

Federation (one realm trusting another; reserve `extensions`), a member roster, network-wide encryption keys (group keys
in `core` can attach to an epoch later), services as first-class realm objects (they stay with `describe` and discovery),
a TUI, and server-side membership enforcement.

## 10. Open questions

Answered by the owner on 2026-11-26 (now in section 2): one identity per realm, derived from one seed; the authority-less
open realm as its own form; a new `browsermesh-realm` package; canonical JSON with Ed25519 and test vectors; a 7-day
default credential `ttl`; a 5-minute clock-skew tolerance.

Still open:

1. **Adopting a descriptor from gossip.** Proposed: a peer always verifies a higher-serial descriptor against the pinned
   realm id and its rotation chain before adopting it, and never adopts an unverified one. Not yet confirmed.
2. **The derivation scheme.** Which KDF and which context string per realm id, and how the seed is stored and exported in
   the wallet. To be settled with the wallet code, not here.

## 11. Staged order

1. This note, reviewed.
2. The library: descriptor, roles, credential, proof, ledger, with test vectors, and the registry grant source.
3. `createMeshNode({ realm })`.
4. The meshctl commands.
5. Real-peer tests: a realm with an invite and an open mode, revocation by epoch, a keyless credential, and a replayed
   descriptor.
6. Optional later: tickets with an admitter, server-side filtering, federation.
