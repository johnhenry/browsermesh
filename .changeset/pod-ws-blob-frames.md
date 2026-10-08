---
"@johnhenry/browsermesh-pod": patch
---

`WebSocketTransport` now reads `Blob` frames (asynchronously, queued so frames keep their arrival order) instead of dropping them (#221).
