---
"@johnhenry/browsermesh-apps": minor
---

`createTorrentService()` gains hooks a real app needs (#199):

- `chunkStore` and `manifestStore`: inject durable stores (for example `IndexedDBChunkStore` from browsermesh-sync) so a seeder that reloads keeps serving. `TorrentManager` accepts the same two options, plus `chunkSize`, and restores `listTorrents()` from them. Stores you pass in are never cleared by `destroy()`. The defaults stay in-memory, as before.
- `authorize(fromPubKey, { kind, magnetURI, infoHash, cid, chunkCid })`: gate who may fetch manifests and pieces. A refused request gets exactly the reply an unknown one gets, so peers cannot probe what exists. Omitted means open, as before.
- Serve limits: `maxConcurrentServes` (default 16), `maxConcurrentServesPerPeer` (default 4), `maxBytesPerPeerPerSec` (default unlimited) and `maxAnnouncesPerPeerPerMinute` (default 30). Over a cap a requester is told `busy` and downloaders back off and retry. `0` means unlimited.
- New events `torrent:request-denied` and `torrent:serve-busy`; `torrent:chunk-served` and `torrent:chunk-received` are unchanged.
- `createMeshNode({ torrentOptions })` forwards all of the above.

Behaviour changes to know about: a node now only serves pieces that a manifest it holds lists (pieces that happen to sit in a shared store are not reachable); a `manifest-request` for unknown content is answered with `manifest: null` instead of silence, and a requester that asked several peers waits for a real manifest or for every peer to decline; chunk responses are only accepted from the peer that was asked.

`TorrentManager.seed()` and `createTorrentService().api.seed()` now accept a string (UTF-8 encoded), `Blob`, `ArrayBuffer` and any typed array, and throw a `TypeError` for anything else. Previously a string was silently seeded as zero bytes (#195). `TorrentManager.getManifest(magnetURI)` is new.

`IPFSStore` no longer pretends to have an IPFS backend (#197): the CDN Helia hook, which could never activate, is removed. It is a mesh-local content-addressed store whose CIDs are SHA-256 hex digests, and is now also exported as `MeshLocalCidStore`. `enabled` is still accepted but has no effect, and `available` is always `false`.
