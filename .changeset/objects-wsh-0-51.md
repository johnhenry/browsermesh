---
'@johnhenry/browsermesh-objects': patch
---

Run on `@johnhenry/wsh` 0.51 (tested range 0.49.0 to 0.51.0; the peer range is unchanged). An event subscription made
through a handle is judged for the root of the handle's path, needs `objects:ROOT:on` at every delivery, and ends the
session when that grant is revoked or expires (before, such events were not delivered). The registry is now also asked
the layer's own question (`permit`) before a root is read or described, so a root the peer holds no action on is not
described, and what is described is narrowed to the actions it holds. Nothing new on the wire; an older peer is
unaffected.
