# Confidentiality for routed messages: options

Status: **built** (option 1, below, with the choices listed under "What was
built"). The rest of this note is the analysis the choice was made from, kept
as written. What is protected today, stated precisely:
[`../security.md`](../security.md#multi-hop-forwarding).

## What was built

- **Key statement** (option 1): `{ v, podId, pk, ka, kid, notBefore, notAfter,
  sig }`, signed with the pod's Ed25519 key over a domain-separated encoding
  (`browsermesh/key-agreement/v1`). `podId` must be the hash of `pk`; at most 24
  h (default 2 h); no grace after `notAfter`; refused when the identity has
  been retired in the session-certificate revocation store, which fails closed.
  Code: `browsermesh-primitives` `key-agreement.mjs`.
- **Carried** on the direct link when a peer is added (`mesh-routing-keys`) and
  fetched on demand with a routed request (`ensureKey`). Not carried in the pod
  hello: the hello is a pod-layer message and the routing service has its own
  link envelope, which keeps the change inside `browsermesh-apps`.
- **Agreement**: ephemeral-static, not static-static. A fresh X25519 key per
  message gives the sender forward secrecy and makes a repeated (key, nonce)
  pair impossible, so the random 12-byte nonce needs no counter or state.
  Static-static would give neither. The recipient's key is static for up to its
  rotation interval (1 h) and is deleted when its statement expires; that is
  the whole of the forward secrecy against the recipient, which is none per
  message. A signed prekey or a session (option 4) would add it.
- **AEAD**: AES-256-GCM, because ChaCha20-Poly1305 is not in WebCrypto in Node
  or the browsers tested. HKDF-SHA-256 with the ephemeral and static public
  keys as salt.
- **Associated data**: originator, recipient and message id (domain
  separated). The session counter is assigned when the envelope is signed,
  after sealing, so it cannot be in the associated data; the outer signature
  covers the ciphertext and the counter together, which binds them.
- **Envelope**: `kind` stays `mesh-routed/v1`; the signed payload carries
  `sealed` and `message: null`. Hops that predate this verify and forward it
  unchanged.
- **Not decided above, now decided**: a message to a pod with no known
  statement is sent readable (and starts a fetch), flagged `sealed: false` at
  delivery, unless `requireSealed` is set, which refuses it with a named error
  and a `drop` event. Algorithms are fixed (no negotiation): a pod that
  publishes a statement supports them. The application sees `sealed: true |
  false` beside `authenticated`.
- **Not built**: forward secrecy against the recipient's key, post-compromise
  recovery, hiding the originator, recipient, size or timing from hops, a
  signed hello that carries the statement, per-peer pinning of statements.

## Where things stand

A routed envelope (`MeshRouter`, `createMeshRoutingService`) carries the
originator's signature over the content, the originator, the final recipient,
a message id and a session counter. A forwarding hop cannot forge or alter the
content or the origin. It can still drop, delay and reorder the message, and it
**can read it**: the signature gives integrity and origin, not secrecy. Per-hop
sealing exists where a hop-to-hop link is a wsh link; nothing seals a message
end to end across several hops.

## What would be needed

A sender must encrypt to the **final recipient**, so it needs a key the
recipient can decrypt with, and it must be sure that key belongs to the
recipient it means. Today:

- A pod id is `base64url(SHA-256(raw Ed25519 public key))`. From the id alone a
  sender cannot recover the key (it is a hash), so the recipient's key is known
  only if it has been seen before.
- `browsermesh-primitives` has Ed25519 identity keys: signing, not key
  agreement. Ed25519 and X25519 are different keys; converting one to the other
  is possible but is a design decision with its own cautions (one key, two
  uses), not something to do silently.
- `browsermesh-core` (`group-keys.mjs`) can generate an X25519 key pair for
  group-key envelope encryption, and says it is a separate key from the signing
  identity. Nothing binds that key to a pod id. Nothing publishes it.
- wsh peer links already do X25519 + ML-KEM-768 inside the link; that
  machinery is per link and is not exposed as a message-level primitive.

So the missing piece is not the cipher: it is a **binding between a pod id and
an encryption key, and a way for a sender to learn it**.

## Options

### 1. A signed encryption-key statement (a "key card")

The recipient signs, with its identity key, a statement
`{ podId, x25519PublicKey, notAfter, sid }` and publishes it (in its hello, or
on request). A sender that has verified one encrypts to that key with an
ephemeral-static X25519 exchange (HKDF to AES-256-GCM, the signed routed
envelope as associated data) and signs the sealed result as it signs any routed
message.

- Binding: the statement is signed by the key whose hash is the pod id, so it
  needs no third party.
- Cost: a way to carry and cache key cards (the pod hello is a natural carrier,
  now that it is signed); a rotation story (`notAfter`, replacement); the first
  message to a peer that has never been seen needs a round trip, or is sent
  unsealed.
- Does not give forward secrecy for the recipient's static key; add a signed
  prekey if that matters.
- Depends on WebCrypto X25519 (not everywhere; `supportsX25519()` exists).

### 2. Derive the agreement key from the identity key

Use the Ed25519 key for key agreement through the birational map to X25519.

- No extra key to publish, so no key card.
- Still needs the recipient's full public key, which a pod id does not carry:
  the sender must have seen it (a hello carries `pk`), so the same carrier
  problem as option 1 remains, only without a second key.
- Reusing a signing key for agreement is the contentious part; if chosen it
  needs domain-separated derivation and a note in the threat model.

### 3. Sealed hops, hop by hop

Do not build end to end; require each hop-to-hop link to be sealed (wsh) and
state that a hop reads what it forwards.

- Already possible; changes nothing in the routed envelope.
- Does not meet "a hop cannot read it". It is the status quo for deployments
  that trust their hops, and should stay documented as such.

### 4. A session established over the route

Run a handshake (Noise-style) between originator and recipient through the
route and carry application messages over the resulting session.

- Gives forward secrecy and replay protection by construction, and amortises
  the key lookup.
- Largest change: it needs state at both ends, a handshake that survives loss
  and reordering by hops that may drop anything, and a session lifetime. It is
  a transport, not a field on the envelope.

## Recommendation (for discussion)

Option 1, with the key card carried in the signed hello, is the smallest step
that gives a real property: a sender that has heard a recipient's hello can seal
to it, a hop sees only ciphertext plus the signed header, and nothing outside
this repository's primitives is needed beyond X25519. Option 3 stays the
documented answer where hops are trusted. Option 4 is the right shape if long
conversations over a route become common.

Whichever is chosen, the signed routed envelope stays as it is: the signature
covers the sealed bytes, so a hop still cannot forge or alter, and the
recipient still learns who sent it and that it is fresh.

## Not decided here

- Whether a message to a peer with no key card yet is refused, queued behind a
  key request, or sent unsealed (and marked so).
- The algorithms and their negotiation for peers without X25519.
- How a sealed message is reported to the application (`confidential: true`
  next to `authenticated: true`).
