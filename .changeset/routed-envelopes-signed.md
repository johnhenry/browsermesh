---
'@johnhenry/browsermesh-apps': minor
---

Routed envelopes (`MeshRouter`, `createMeshRoutingService`) now carry the originator's signature: a pod message signature over the originator, the final recipient, a message id, the content and the signer's session counter. The final recipient verifies it (and refuses a copy it already accepted) and every forwarding hop verifies it and drops what does not verify, so a hop can no longer forge or change a routed message's content, origin or recipient. `path` and `ttl` stay hop-written and are treated as hints (`path` is bounded and decides nothing; `ttl` is clamped to the router's `maxTTL`). A hop forwards only for a peer it has a link with. New `mesh-routing:drop` event (`MeshRouter` event `drop`) with the reason; delivered messages gain `id` and `authenticated`. A hop can still drop, delay, reorder and read a routed message: confidentiality across hops is not provided (options in `docs/design/routed-confidentiality.md`).

`MeshRouter` takes optional `signer`, `allowUnsigned`, `isLinked`, `replay`; `createMeshRoutingService` signs with the node's wallet identity and takes `allowUnsigned`. Without a signer a bare `MeshRouter` behaves as before. `handleRoutedMessage()` returns a promise for a signed envelope.

Breaking default: a node that can sign now refuses unsigned routed envelopes from older peers; set `allowUnsigned: true` to keep accepting them (delivered with `authenticated: false`). Envelopes from this release keep the old top-level `from`, `to`, `ttl`, `message` and `path` and add `id` and `signed`, so an older hop still forwards them and an older recipient still reads them (it cannot verify the signature). The peer dependency on `@johnhenry/browsermesh-pod` is now `>=0.2.0` (the signing scheme).
