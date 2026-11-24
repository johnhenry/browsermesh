---
"@johnhenry/browsermesh-apps": patch
"@johnhenry/browsermesh-netway": patch
---

A JSON message that arrives in window-sized pieces is now reassembled with a bound and parsed once: `readJsonMessage` (apps) and `FsServiceBackend` (netway) scan the bytes they already hold and parse when the document is balanced instead of after every piece, and refuse a message larger than `maxBytes` (default 16 MiB, `maxMessageBytes` option on `FsServiceBackend` and the cloud-storage backend) with an error reply and a closed connection. The wire format is unchanged, so an older peer is served as before.
