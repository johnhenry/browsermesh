---
"@johnhenry/browsermesh-transport": minor
---

Optional identity binding for WebRTC connections. Pass `identity` (a `PodIdentity`) to `WebRTCPeerConnection` or `WebRTCMeshManager` and each side proves possession of its pod key, on the control data channel, over a transcript of both pod ids and the DTLS fingerprints of both session descriptions. The proof's key must hash to the pod id claimed in signalling. The connection is `connected` and accepts application messages only after the peer's proof verifies; a failing proof closes the connection and is reported through `onError()` (`bindingFailure`). A peer that sends no proof is closed after `bindingTimeoutMs` (default 10000) unless `requirePeerBinding: false`. New exports from `identity-binding.mjs`: `extractDtlsFingerprints`, `bindingTranscript`, `createBindingProof`, `verifyBindingProof`.

Nothing changes without `identity`. An older peer receiving the proof sees one extra `mesh:bind` JSON message on the control channel. Verified with an in-memory duplex and fixed vectors, not over a real browser `RTCPeerConnection` (issue #270).
