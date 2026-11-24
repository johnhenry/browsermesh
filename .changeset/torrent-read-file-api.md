---
"@johnhenry/browsermesh-apps": patch
---

`TorrentManager` now reads a finished download with `file.stream()` (falling back to `file.arrayBuffer()`, and to the callback `file.getBuffer()` for a 1.x client) instead of calling `getBuffer()` unconditionally, which WebTorrent 2.x removed and which left `download()` hanging. A failed or timed-out download rejects and is removed from the client, and `onProgress` is attached before the transfer can start.

Downloads are now bounded in memory: `download(magnet, { maxBytes })` rejects a file larger than `maxBytes` (default `TORRENT_DEFAULTS.maxDownloadBytes`, 256 MiB; pass `Infinity` to lift it). An application that downloads larger files through the real-WebTorrent path must pass `maxBytes`.
