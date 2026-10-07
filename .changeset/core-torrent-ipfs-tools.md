---
"@johnhenry/browsermesh-core": minor
---

Fix the `torrent_seed`, `ipfs_store` and `ipfs_retrieve` agent tools (#195, #196).

- `torrent_seed` takes an `encoding` parameter, `"text"` (default) or `"base64"`, and decodes `data` to bytes before seeding. Before, the string went straight to the manager and was seeded as zero bytes. The result now names the magnet URI and byte size. Invalid base64 is rejected.
- `ipfs_store` takes the same `encoding` parameter and reports `Stored with CID: <cid> (<n> bytes)` instead of `[object Object]`.
- `ipfs_retrieve` returns the content as UTF-8 text, or as base64 (with an explicit `encoding` field) when the bytes are not text, instead of a JSON byte-index object. An optional `encoding` parameter forces `"text"` or `"base64"`.
- The `ipfs_*` tool descriptions now say the store is mesh-local with SHA-256 hex CIDs.
