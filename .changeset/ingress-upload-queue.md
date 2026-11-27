---
'@johnhenry/browsermesh-ingress': minor
---

Uploads: a bounded wait for a slot, and an early cut of an upload that cannot finish (#472). Behaviour changes, both applied by the ingress and by the pod on its own:

- A request with a body that finds every upload slot on a pod link busy no longer gets the 503 `provider-uploads` at once: it waits in a FIFO queue for at most `uploadQueueMs` (default 2000) with at most `uploadQueueMax` (default 8) waiting; beyond either bound the 503 is as before (`0` turns the wait off). A client's queued uploads count against `maxUploadsPerClient`; a queued request whose client disconnects leaves at once. New CLI flags `--upload-queue` and `--upload-queue-max` (config keys `uploadQueue`, `uploadQueueMax`). The pod's `serveHttpOnMesh` takes the same two limits.
- After the 30 s grace, an upload whose remaining bytes cannot arrive before the upload deadline at its observed rate (bytes received over the time spent waiting on the sender, so a slow origin is not counted) is cut at once with a new 408 `upload-too-slow`, instead of holding its slot until the deadline. A declared `Content-Length` that cannot be sent in the whole deadline even at `uploadMaxBytesPerSec` (default 256 MiB/s) is refused unread with a new 413 `upload-exceeds-deadline`. An upload that can finish is never cut; a chunked upload keeps only the existing 1 KiB/s floor.
