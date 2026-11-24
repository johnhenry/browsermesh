---
'@johnhenry/browsermesh-pod': minor
'@johnhenry/browsermesh-transport': patch
---

Discovery messages (`pod:hello`, `pod:hello-ack`, `pod:goodbye`) are now signed with the same scheme as other pod messages, and a peer list entry exists only for a key that proved itself. A goodbye is honoured only from the peer it names (for the session that said hello), or from the link that peer was on going down. What a relay or signalling server reports about peers (`peers`, `peer-joined`, `peer-left`, a relayed frame's `source`) is a hint of whom to greet: `WebSocketTransport` sends a hello to a hinted pod and any other broadcast only to pods whose signed hello or ack verified (new `verifiedPeers`, `confirmPeer()`, `forgetPeer()`). Peers carry `authenticated` and `sid`.

Breaking default: over a relay or a custom adapter, an unsigned hello from a pod on 0.2.0 is now refused (counted as `unsigned`), so such a pod no longer joins the peer list or receives broadcasts. Set `allowUnsigned: true` on the newer pod to keep accepting them (listed with `authenticated: false`); same-origin transports keep accepting them by default. Signed hellos are accepted by 0.2.0 pods, which ignore the added fields.

`@johnhenry/browsermesh-transport`: `WshPodTransport` now hands the pod the goodbye it synthesises when a link goes down under the link's identity (`{ peerId }`), so a pod on this release honours it. A pod on an older release is unaffected.
