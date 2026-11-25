---
'@johnhenry/browsermesh-transport': minor
---

`StreamMultiplexer` accepts `maxViolations` (off unless given): the rules a peer must keep on what it sends are then
enforced and counted (data within the credit granted, in sequence on ordered streams, within the chunk and stream size
limits; credit grants that are positive whole numbers within the credit limit; no duplicate opens, no opens past the
concurrency limit, no frames for streams that do not exist), a frame that breaks one is dropped, and a peer that breaks
more than the budget is cut off: every stream is cancelled, `onAbuse` is called once, and nothing further from it is
processed or answered. New `violations`, `abused` and `onAbuse()`. Receive-side only: no frame on the wire changes, so an
older peer is unaffected, and behaviour without `maxViolations` is as before.
