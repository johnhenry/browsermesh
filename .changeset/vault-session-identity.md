---
"@johnhenry/browsermesh-primitives": minor
---

Vault-friendly identity, session certificates and signed revocation. `PodIdentity` can now be built from a non-extractable key (`generate({ extractable: false })`, `fromCryptoKeyPair`), an imported JWK or PKCS#8 key (non-extractable by default), or an external signer (`fromSigner({ publicKey, sign })`, the shape `@johnhenry/wsh` takes); all signing goes through the one `sign()` seam and `exportPrivateKey()` rejects unless the identity is exportable. New: versioned, length-prefixed session certificates (`createSession`, `issueSessionCertificate`, `verifyPeerCredential`, `scopeAllows`), signed revocation of a session or of an identity (`revokeSessionCertificate`, `retireIdentity`, `receiveRevocation`, `isRevoked`) and a bounded pluggable store (`MemoryRevocationStore`). Existing exports and behaviour are unchanged.
