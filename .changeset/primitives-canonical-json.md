---
"@johnhenry/browsermesh-primitives": minor
---

Strict canonical JSON for signed objects: `canonicalJson`, `parseCanonical`, `domainSigningBytes`, `CanonicalJsonError`.

The profile (docs/design/realms.md 5.2) is deterministic outside JavaScript too: integers only up to 2^53-1, ASCII keys sorted by code unit, no whitespace, one fixed string escaping. `parseCanonical` is a purpose-built parser that rejects duplicate keys, floats, `-0`, leading zeros, whitespace and any input that is not byte-identical to its own canonical form, with typed errors. `domainSigningBytes` prefixes a per-object-type domain (`UTF-8(domain) || 0x00 || UTF-8(text)`). Language-neutral test vectors ship in the repository under `test/vectors/`. New module only; `browsermesh-core`'s encoder and every existing signing format are unchanged.
