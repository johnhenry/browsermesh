---
"@johnhenry/browsermesh-transport": patch
---

Fixes browsermesh#208. `WebRTCTransport`, `WebSocketTransport` and `WebTransportTransport` (in `websocket.mjs`) handed whatever they were given straight to the platform. `RTCDataChannel.send()` and `WebSocket.send()` only take a string or binary, and silently turn anything else into the text `"[object Object]"`, so every envelope object `PeerNode.sendTo()` and every `MeshService` sent over a real session arrived as garbage.

`send()` on those three classes now sends strings and binary unchanged and any other value as its JSON text, the same rule `WebRTCPeerConnection.send()` already followed. `WebRTCPeerConnection.send()` uses the same helper, so it no longer turns an `ArrayBuffer` or typed array into `"{}"`.

The rule is exported as `encodeWireData()` (with `isWireNative()`) so a custom transport can follow it. It throws a `TypeError` for a value with no JSON form (`undefined`, a function) instead of sending the text `"undefined"`.
