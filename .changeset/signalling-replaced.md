---
'@johnhenry/browsermesh-core': minor
'@johnhenry/browsermesh-pod': minor
---

The signalling clients honour a displaced connection.

The signalling server now lets a verified pod hold several connections (default 2), delivers a message for it to the newest, and when it displaces one it sends `{ type: 'error', code: 'replaced', reconnect: false, message }` and closes it 4409 `replaced`. `WebSocketTransport` (pod) and `SignalingClient` (core) do not reconnect a displaced connection (that would displace another in turn). The transport sets `replaced` and calls the handlers of the new `onReplaced(fn)`; the client fires a `replaced` event and sets `replaced`; the application decides whether to connect again. A 4409 close with reason `replaced` is enough even if the error frame was lost. Other closes reconnect as before, and an open-mode or older server's 4409 `podId already registered` behaves exactly as it did.

A pod that uses the same signalling server for its primary connection and for `signalingUrl` now keeps both connected and receives each message once: when the primary is a signalling connection, a `signal` frame delivered on the secondary connection (the server sends to the newest) is handled like one on the primary.

Older servers send none of the new frames, so nothing changes against them.
