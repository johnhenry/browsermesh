---
"@johnhenry/browsermesh-apps": patch
"@johnhenry/browsermesh-netway": patch
---

The JSON request/response sockets (`CloudStorageBackend` / `CloudStorage`, and netway's `FsServiceBackend`) no longer assume one `read()` is one message. A socket with a receive window hands a write larger than the window to its reader in window-sized pieces, so these readers now reassemble a message across pieces before parsing it; objects and files over 256 KiB round-trip again.
