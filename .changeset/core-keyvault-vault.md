---
"@johnhenry/browsermesh-core": minor
---

`VaultIdentityStorage` and encrypted identity export/import now use `@johnhenry/keyvault` instead of hand-rolled PBKDF2/AES-GCM helpers.

KDF change: new records are written with keyvault's current default (PBKDF2-SHA256, 600,000 iterations, up from 310,000), and the KDF parameters are authenticated along with the record.

Compatibility:

- Existing records still open: 310,000-iteration records, records written before `kdf`/`iterations` were recorded, and passphrases containing Unicode (read exactly as typed, with no normalisation, as before).
- When an old record is unlocked successfully, `VaultIdentityStorage.load()` re-encrypts it with the current defaults and writes it back (best effort: a failed write-back does not fail the unlock).
- Stored shape changes: `encryptedPrivateKey` is now a keyvault record (`{ v, t, kdf: { name, iterations, salt }, iv, ct }`) rather than `{ kdf, iterations, salt, iv, ciphertext }`. An older browsermesh-core reading a record written by this version refuses it with `Unsupported key derivation function` before attempting any decryption; it does not misread it. Upgrade every reader of a shared store before the first write by the new version.
- `MeshIdentityManager.export(podId, passphrase)` returns a keyvault record with `encrypted: true`; `import()` reads both this and the old envelope.
- Errors are unchanged: a wrong passphrase rejects with a `DOMException` named `OperationError` (the `VaultError` is on `cause`), and empty/`undefined`/non-string passphrases are still refused.
