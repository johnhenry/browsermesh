---
"@johnhenry/browsermesh-sync": minor
---

`MeshFileTransfer.subscribeProgress(fn)` adds a multi-listener progress subscription (returns an unsubscribe function) for both sending and receiving. Events carry `{ transferId, direction, bytesDone, bytesTotal, percentComplete, transferRate, state }` and also fire on completion and cancellation. The single-slot `onProgress` keeps working unchanged. Events are not throttled.
