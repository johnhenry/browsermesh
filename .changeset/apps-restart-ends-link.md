---
"@johnhenry/browsermesh-apps": patch
"@johnhenry/browsermesh-ingress": patch
---

A node whose peer starts over on the WebRTC connection it holds open (a fresh offer for an open connection: a page loaded again, a node made anew) now ends the channel link that ran over the old connection. Before, the link stayed: a restarted pod that only serves (a hand `--map` at the ingress, no name claimed) sends no hello of its own, so the ingress went on sending over a link the new node knows nothing of, and every request waited out the open timeout for a 504 `provider-timeout`. Now the requests on the old link end at once (502 `provider-closed`) and the next request opens a new link on the new connection. `onIncomingConnection` gets a fourth argument `{ restarted }`, `adoptIncomingSession` takes `{ restarted }` and emits `peer:transport-restart`, and the mesh channel service follows it. Nothing is added to the wire: an older pod is served as before, and an older ingress behaves as it did. The ingress README says so.
