---
'@johnhenry/browsermesh-primitives': minor
'@johnhenry/browsermesh-transport': patch
---

One conversion between a pod id and a wsh fingerprint, and explicit OpenSSH public key interop (#334).

primitives: `podIdToFingerprint` / `fingerprintToPodId` (the same 32 bytes in base64url and in hex; strict about length and encoding), `openSSHPublicKeyFromRaw`, `rawPublicKeyFromOpenSSH` (exactly one `ssh-ed25519` key: options, other key types and non-canonical or multi-line input are refused), `podIdFromOpenSSHPublicKey`, `authorizedKeysLine`, and on `PodIdentity` `toOpenSSHPublicKey()` and `toAuthorizedKeysLine({ capabilities, expires, comment })`. `capabilities` is required (an empty list is a key that may do nothing) and characters that could end an option or the line are refused. Nothing calls any of this by default, nothing reads or writes a key file, and only public keys cross (there is no OpenSSH private key parser). See `docs/security.md`, "One key in both worlds".

transport: `podIdToFingerprint`, `fingerprintToPodId` and `podIdFromRawKey` are no longer implemented here; the names are still exported from the package and are now the primitives functions, so the repository has one conversion. These functions need `@johnhenry/browsermesh-primitives` >= 0.6.0: the peer range must be raised to match in the version bump (it cannot be installed ahead of the release).

Additive. A `fingerprintToPodId` / `podIdToFingerprint` that was given something that is not a canonical 32 byte value used to accept a non-canonical final base64url character; it is now refused.
