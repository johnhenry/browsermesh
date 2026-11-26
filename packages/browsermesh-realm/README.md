# @johnhenry/browsermesh-realm

The pure-logic core of **realms** (design: [docs/design/realms.md](../../docs/design/realms.md)): signed realm descriptors,
root rotation, roles, issuer-signed credentials, and the issuer ledger.

**Status: private, not yet published, used by nothing in production.** The pure logic has no I/O, no network and no clock
of its own: every function takes plain objects and an injectable `now`. The realm exchange (below) talks to a duck-typed
channel and a duck-typed registry, so it needs no transport either. `createMeshNode({ realm })`, renewal over the protocol
seam and `meshctl` are later stages. It depends on `@johnhenry/browsermesh-primitives` only (peer dependency, `>=0.8.0`,
the first release that exports `canonicalJson`), never on
`browsermesh-apps` or `browsermesh-core`; the integration tests that use the real `PeerRegistry`, the real admission seam
and a real wsh link live in `browsermesh-apps` (`test/realm-exchange-wsh.test.mjs`), which has this package as a devDependency.

Everything is signed with Ed25519 over strict canonical JSON (`canonicalJson` / `parseCanonical` /
`domainSigningBytes` from primitives). One domain per object type:

| Object | Domain |
| --- | --- |
| descriptor | `browsermesh-realm/descriptor/1` |
| authority-less id (hash, not a signature) | `browsermesh-realm/authorityless-id/1` |
| rotation statement | `browsermesh-realm/rotation/1` |
| rotation countersignature | `browsermesh-realm/rotation-accept/1` |
| credential | `browsermesh-realm/credential/1` |
| ticket (reserved, not built) | `browsermesh-realm/ticket/1` |

Keys and signatures are base64url strings (raw 32-byte key, 64-byte signature, strict: no padding, no stray bits). Times
are **whole seconds** (the registry takes milliseconds; the caller multiplies). `now` is seconds, or a function returning
them. Verifiers never throw on hostile input: they return `{ ok: false, reason, detail }`. Builders throw a typed
`RealmError` with a stable `code`.

## Usage

```js
import { createDescriptor, signDescriptor, verifyDescriptor, adoptDescriptor,
         issueCredential, verifyCredential, checkSubject, createCredentialTracker } from "@johnhenry/browsermesh-realm";

const d = await createDescriptor({ name: "my realm", root: { key: rootKey }, issuers: [{ key: issuerKey, notAfter }],
                                   roles: { guest: ["protocol:mcp:open"], member: ["mcp:search:call"] } });
const { text } = await signDescriptor(d, rootIdentity);            // canonical text, sig inside
const v = await verifyDescriptor(text, { pinnedId: d.id, now });    // { ok, descriptor, chainLength } | { ok: false, reason }

const { text: cred } = await issueCredential({ realm: d.id, subject: memberKey, role: "member", serial: 1,
                                               notBefore, notAfter, epoch: 0 }, issuerIdentity);
const c = await verifyCredential(cred, v.descriptor, { now, tracker });  // clamps lifetime, checks epoch/revoked/issuer
checkSubject(c, keyTheLinkProved);                                       // for the exchange layer
```

## What is checked, in order

- **Descriptor** (`verifyDescriptor`): size, strict canonical parse (anything not byte-identical to its own canonical
  form is refused), shape and roles, pinned id, rotation chain, root signature, `validUntil`. The realm id is the
  base64url SHA-256 of the **genesis** root key (the pod-id derivation), so rotation never changes it.
- **Adoption** (`adoptDescriptor(held, offered, { pinnedId, now })`): the offered text must verify end to end AND have a
  strictly higher `serial`; its `epoch` may not drop; its chain may not fork or shorten what is held. Size and chain
  length are capped (16 KiB, 8).
- **Roles**: a scope is `ns:resource:action` written out in full. A `*`, fewer than 3 segments (a wildcard under
  `matchScope`) or an empty segment is rejected at parse, even if correctly signed, so write `mcp:tool:call`, not
  `mcp:tool`.
- **Credential** (`verifyCredential`): size, canonical parse, realm id, descriptor freshness, issuer listed (and its own
  expiry), signature, role defined, epoch not below the descriptor's, serial not in `revoked`, then the lifetime:
  `effective notAfter = min(notAfter, notBefore + ttl, issuer.notAfter)`, with a clock-skew tolerance of 300 s (the
  `skew` option is capped at 300, never more). So a compromised issuer cannot mint past `ttl`, and backdating
  `notBefore` only moves the window into the past. A credential with an epoch **above** the descriptor's is accepted and
  flagged `descriptorBehind`. There is no keyless credential; the subject is always a key.
- **Monotonic checks** (`createCredentialTracker`): `PeerRegistry` replaces grants by (realm, peer, role) and does not
  order serials, so a verifier holding a newer serial for the same (realm, issuer, subject, role), or a higher epoch
  for the realm, refuses an older credential (`stale-serial`, `epoch-too-old`). Pass the tracker to `verifyCredential`
  or call `admit`/`check` yourself. It is bounded (it refuses new keys when full, after evicting expired ones; it never
  forgets a live serial).
- **Ledger** (`createLedger`): in-memory, append-only (the only state change is `issued` to `revoked`), serial
  allocation, `revokedSerials` to feed `descriptor.revoked`, `compact` for dead entries, and canonical-JSON
  `export`/`importLedger` with size caps. Serials are per ledger: a realm with several issuers must give each ledger a
  disjoint `serialStart` or share one ledger, because `descriptor.revoked` has no issuer field.
- **Authority-less open form** (`createAuthorityless`, `verifyAuthorityless`): no root, no issuers, no signature; the id
  hashes (name, roles, salt) only; the rendezvous `hints` sit outside the hash and are replaceable candidates, not
  authority. It carries exactly one role, `guest`, and never an `egress:`, `ingress:`, `pod-host` or `wsh-` scope.

## The realm exchange

`createDescriptorStore`, `createRealmVerifier` and `createRealmProver` implement `realms.md` 5.5 on a link whose peer key is
proven but not yet known.

```js
const store = createDescriptorStore({ pinnedId, held: bakedDescriptorText, now });   // await store.ready
const { handler } = createRealmVerifier({ pinnedId, store, registry /* a PeerRegistry */ });
const admission = createLinkAdmission({ decide: () => "restrict", handler });         // browsermesh-apps; createMeshNode({ admission })

// the dialler, with a channel over its link to the host (send, onFrame, onClose, close):
const result = await createRealmProver({ pinnedId, store: ownStore, credential: credentialText, channel, timeoutMs: 5000 });
// { ok: true, role, notAfter } | { ok: false, reason }
```

**Frames** (`realm:*`, JSON objects, each field checked and size-capped; `parseFrame` takes an object or JSON text):

| `t` | fields | sent by | meaning |
| --- | --- | --- | --- |
| `realm:hello` | `id`, `serial`, `epoch` | both | the realm, and the descriptor held (`serial` 0 = none) |
| `realm:need-descriptor` | `have` | the side that is behind | "send yours; I hold serial `have`" |
| `realm:descriptor` | `text` (<= 16 KiB) | the side that is ahead | the exact canonical text; verified, never trusted |
| `realm:credential` | `text` (<= 2 KiB) or `null` | prover | its credential; `null` asks for the open-mode default role |
| `realm:result` | `ok`, `reason?`, `role?`, `notAfter?` | verifier | the verdict; `notAfter` in whole seconds |

**Order.** The verifier sends its hello at once. On the peer's hello, the side that is behind asks for the descriptor; the
prover sends its credential only after that is settled. The verifier then checks the credential against the CURRENT
descriptor (`verifyCredential`), the subject against the key the link proved (`checkSubject`), the order against a tracker,
computes the role's scopes from the descriptor, calls `registry.grantRealmScopes(...)` (`notAfter` in milliseconds), and only
then sends `realm:result` and calls `promote()`. A link restricted by the seam is not in the registry: granting first is what
keeps the promoted peer from being closed by the default access watcher at its next access change. **A role must therefore
include `mesh:link:connect` and the host's policy must admit it**, or the watcher closes the link at that re-check.

**Subject.** A credential's `subject` is the peer's POD ID (what a link calls `peerKey`: the registry and wsh key by it),
not the raw public key.

**Refusal reasons** (`realm:result.reason`, then `link.close(reason)`; stable):
- protocol: `bad-frame`, `unexpected-frame`, `too-many-frames`, `wrong-realm`, `unproven`
- descriptor: `descriptor-rejected` (a peer's descriptor did not verify, was a fork or regression, or was not higher),
  `rate-limited`, `no-descriptor`, `descriptor-stale`
- credential: `no-credential`, `subject-mismatch`, `credential-rejected`, and the package's own `malformed`, `too-large`,
  `not-canonical`, `unsupported-version`, `issuer-not-listed`, `bad-signature`, `unknown-role`, `epoch-too-old`, `revoked`,
  `not-yet-valid`, `expired`, `stale-serial`, `tracker-full`
- grant: `no-grant` (the registry granted nothing), `grant-error` (it threw)
- `internal-error`. The prover adds `peer-does-not-speak-realms` (no `realm:` frame before `timeoutMs`; an older peer
  ignores unknown types), `timeout` (it began and stalled) and `peer-closed`. A peer that goes quiet is the seam's deadline's
  problem, not the handler's: the handler holds no timer.

**Unproven links** are refused (`unproven`), guest or not: a grant to a key the link did not prove would be a grant to
whoever claims it.

**Descriptor adoption** is bounded. An offer is size-capped, costs a JSON read when its serial is not higher than the held one
(no signature check), and is rate-limited per link and across links (`createDescriptorStore({ limits })`). Offers are
serialised. When the store adopts a descriptor with a higher epoch the verifier calls `registry.revokeRealmGrants({ realmId,
belowEpoch })`, and for each newly listed revoked serial `revokeRealmGrants({ realmId, serial })`, so open links re-check.
Persist `store.export()` and feed it back as `held`. A removed issuer's existing grants are not revoked (a grant does not
record its issuer); they end at `notAfter`.

**Ordering is this layer's job.** `PeerRegistry` replaces a grant by (realm, peer, role) and does not order serials; the
verifier asks the tracker first, so a second exchange from a granted peer with a NEWER serial renews, and an older serial
arriving later is refused (`stale-serial`). The same serial again (a reconnect) is accepted.

**Admission seam sizing.** The seam drops frames over its `maxFrameBytes` (default 16 KiB), and a descriptor's JSON escaping
can double it: a host that wants to receive descriptors of any allowed size sets `maxFrameBytes: MIN_SEAM_FRAME_BYTES`.

**Not here.** Renewal over an open link (a fresh credential before `notAfter` without re-linking) needs the protocol seam
(stage 4). Re-linking renews only when the peer reaches the handler at all: a peer the registry already allows is admitted as
an ordinary link and never put to the exchange. Tickets are not built.

## Rotation and its known limit

A rotation statement is signed by the outgoing root and **countersigned by the successor** (so the successor provably
holds the key), names a chain position and an effective time, and is checked from the genesis key. The first-seen fork
rule: a verifier that holds a chain position never accepts a different statement for it (`chain-fork`), and never
accepts a shorter chain (`chain-regressed`).

**Known limit.** A retired root key that later leaks can sign a competing successor; a verifier that has seen nothing
but the genesis key (a fresh page) cannot tell the fork from the real chain and will accept whichever it meets first.
Rotation limits the damage of key aging and planned changes, not of compromise. A compromised current root ends the
realm.

## Test vectors

`test/vectors/{descriptor,rotation,credential}.json` are language-neutral: fixed 32-byte seeds as hex, the public
keys, the canonical unsigned text, the signature, the exact signed bytes, and accept/reject verdicts (non-canonical,
wrong domain, tampered field, expired, clock-skew edge, revoked serial, removed issuer, older epoch, stale serial,
forked chain, ...). `npm run vectors` regenerates them from `test/make-vectors.mjs` (every verdict there is written by
hand); `vectors.test.mjs` fails if the committed files drift from what the generator produces.

## License

MIT
