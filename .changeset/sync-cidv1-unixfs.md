---
"@johnhenry/browsermesh-sync": minor
---

Add opt-in IPFS CIDv1 / UnixFS addressing (#249): `ChunkStore.computeCid(data, { format: 'cidv1' })`, `computeCidV1`, `buildUnixfsFile`, `buildUnixfsDirectory` (root CID plus per-block CIDs), `verifyBlock` (SHA-256 hex or CIDv1), and hex/CID conversion helpers. Root CIDs match `ipfs add -r --cid-version=1 --raw-leaves`. The default SHA-256-hex `computeCid()` is unchanged. Zero new dependencies.
