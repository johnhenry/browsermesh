---
'@johnhenry/browsermesh-apps': minor
---

End-to-end sealing of routed messages.

A routed message to a pod whose current key statement this pod holds is sealed to that pod (ephemeral-static X25519, HKDF-SHA-256, AES-256-GCM; the originator, recipient and message id are the associated data). The signed envelope keeps `kind: 'mesh-routed/v1'` and carries the sealed box in `payload.sealed` with `message: null`, so forwarding hops still verify the originator's signature and the replay rules are unchanged, but they hold no key for the content. The message event carries `sealed: true | false` next to `authenticated`.

Key statements (a pod's X25519 key signed by its identity key, expiring, rotated every hour, refused for a retired identity) are exchanged on the direct link when a peer is added (`mesh-routing-keys`) and fetched through the route on demand: `api.ensureKey(podId)`, `api.keyStatement()`, `api.learnKeyStatement(statement)`, `api.getKeyStatement(podId)`. Options: `sealing: false` turns it off, `sealingOptions` (`lifetimeMs`, `rotationMs`, `maxBytes`, `revocations`, `now`), `requireSealed` on the service or on one `api.route(podId, message, { requireSealed: true })`: a message that cannot be sealed is refused with `SealedUnavailableError` (code `E_SEALED_UNAVAILABLE`) and a `mesh-routing:drop` event (`sealed-unavailable`), and a node with `requireSealed` refuses readable envelopes addressed to it (`unsealed`). New drop reasons: `sealed-too-large`, `sealed-unsupported`, `bad-seal`.

Behaviour changes to know about: with sealing on (the default for a node that can sign and has X25519), the first message to a pod whose statement is not known yet goes out readable as before and starts a key request through the route (at most once a minute per pod), so a service sees an extra signed control message per new destination; call `await api.ensureKey(podId)` first to have the first message sealed. A pod on an earlier release publishes no statement and is sent the readable envelope it understands; an earlier hop forwards a sealed envelope unchanged. Hops still see the originator, recipient, size and timing, and can still drop, delay and reorder.
