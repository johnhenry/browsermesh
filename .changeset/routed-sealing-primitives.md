---
'@johnhenry/browsermesh-primitives': minor
---

Signed key-agreement statements and sealing to them (`key-agreement.mjs`).

`generateAgreementKeyPair()`, `createKeyStatement(identity, pair, { now, lifetimeMs })`, `verifyKeyStatement(statement, { now, expectedPodId, revocations })`, `sealToStatement(verified, { aad, plaintext, maxBytes })`, `openSealed(box, { privateKeys, aad, maxBytes })`, `supportsKeyAgreement()`, `keyIdOf()` and `KeyAgreementError` (with a `code`).

A statement binds an X25519 key to a pod id: it is signed by the Ed25519 key whose hash is the pod id, lasts at most 24 hours with no grace after `notAfter`, and is refused for an identity retired in the revocation store used for session certificates. Sealing is ephemeral-static X25519, HKDF-SHA-256 and AES-256-GCM with a fresh key and a random nonce per message and the caller's header as associated data. WebCrypto only; runs in Node and the browsers.

Additive. Nothing in existing exports changes.
