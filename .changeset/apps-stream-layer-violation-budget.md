---
'@johnhenry/browsermesh-apps': minor
---

`createStreamLayer` accepts `maxViolations` and `onAbuse` (off unless `maxViolations` is given): the rules a peer breaks
on its streams (data out of sequence, past its credit, past the chunk or stream size, without bytes) and the opens that
are refused for a reused or invalid id or for being past `maxStreams` are counted across all streams of that peer, and a
peer that goes past the budget is cut off: every stream fails with `stream-abuse`, `onAbuse` is called once, later opens
are refused and nothing further it sends is processed or answered. New `violations` and `abused` on the layer.
Receive-side only: no frame on the wire changes, so an older peer is unaffected, and behaviour without `maxViolations`
is as before.
