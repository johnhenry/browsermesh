---
"@johnhenry/browsermesh-transport": patch
"@johnhenry/browsermesh-core": patch
---

Fix three-pod meshes where one link came up one-way and a pod ended with no sessions (#224). `WebRTCTransport` now acts only on answers and ICE candidates from its own remote peer, applies an answer once, and unsubscribes from the shared signaler when it closes; before, every in-flight negotiation on a pod applied every peer's answer to its own `RTCPeerConnection`. `SignalingClient#on`, `onOffer`, `onAnswer` and `onIceCandidate` now return an unsubscribe function (they returned `undefined`). A signaler that does not report who a message is from keeps working unchanged.
