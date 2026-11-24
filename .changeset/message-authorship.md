---
"@johnhenry/browsermesh-pod": minor
---

A receiver never takes the sender of a `pod:message`, `pod:rpc-request` or `pod:rpc-response` from a field the sender or a relay wrote.

- Pods sign outgoing messages by default (option `sign`): the message carries the sender's public key, a session id, a counter and an Ed25519 signature over a canonical encoding of sender, recipient, type, body and those fields. The receiver checks that `from` is the pod id of the key, verifies the signature, and refuses a repeat within a sliding window per sender session (clocks are not used). Only signed fields are delivered, with `authenticated: true`. New exports: `MessageSigner`, `verifyMessage`, `signedBytes`, `ReplayGuard`, `ReplayWindow`.
- A transport that authenticates the peer itself can pass `(msg, { peerId })` to its handler; a message whose `from` differs is dropped.
- Refused messages are counted in `pod.dropped` and announced as `message:dropped`.
- **Breaking**: unsigned `pod:message` / `pod:rpc-response` from older peers are accepted only from transports that declare `trust === 'same-origin'` (`BroadcastChannelTransport`, `EventEmitterTransport`, `NullTransport`) and from window messages; they are refused from `WebSocketTransport` (`trust` `'untrusted'`) and from custom adapters that declare nothing. Set `allowUnsigned: true` to take them anyway, `false` to refuse them everywhere. An unsigned `pod:rpc-request` is no longer accepted by any pod.
- **Breaking**: `send()` and `broadcast()` return a promise (signing is asynchronous) and need JSON-compatible payloads. Pass `sign: false` to keep unsigned sending; a `{ podId }` identity that cannot sign sends unsigned.
- `WebSocketTransport` no longer turns the relay's `source` into the message's `from`; it is delivered as `relaySource`.
- An older peer receiving a signed message sees extra fields (`pk`, `sid`, `seq`, `sig`) and otherwise the same message.
