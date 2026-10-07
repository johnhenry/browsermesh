---
"@johnhenry/browsermesh-apps": minor
---

`createTorrentService()` `api.download()` and `TorrentManager`:

- `download(magnet, { onManifest })`: awaited between learning the manifest and requesting pieces, so a host with a storage quota can refuse before anything is fetched or stored. Return `false` (rejects with `code: 'manifest-rejected'`) or throw to abort.
- `download(magnet, { onProgress })`: `{ received, total, bytes, size, cid, from }` per piece.
- Pieces are now fetched in parallel: `download(magnet, { concurrency })` (1-32) with a service-level `downloadConcurrency`, **default 4** (was strictly one at a time). `concurrency: 1` keeps the old sequential order. Providers' `busy` answers are still retried with backoff.
- A download that fails part-way removes the pieces it wrote itself (and that no held torrent lists), and emits `torrent:download-failed`.
- Manifests remembered from other peers are bounded: `maxManifestChunks` (default 16384), `maxManifestSize`, 64-hex piece CIDs, and a piece count that matches the size are now required, and `maxRemoteManifests` (default 64) keeps the most recently used, dropping the providers recorded only for evicted ones. Manifests that do not meet this are ignored.
- `TorrentManager` no longer imports `webtorrent` from `https://esm.sh` at runtime (it hung offline and failed under a strict CSP). Pass the library instead: `new TorrentManager({ webtorrent })` / `createTorrentService({ webtorrent })`, a constructor or a client; `window.WebTorrent`/`globalThis.WebTorrent` is still used when present. The new options are also forwarded by `createMeshNode({ torrentOptions })`.
