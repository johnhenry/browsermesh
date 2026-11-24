---
'@johnhenry/browsermesh-pod': minor
---

A pod's window message channel accepts a message only from a window and origin it was told about. New boot option `window: { sources, parent, origins, targetOrigin }`: `sources` are exact Window objects compared with `event.source`, `parent: true` adds the embedding parent (iframe) or opener (spawned window), `origins` are exact origins compared with `event.origin`, and a message must match every constraint given. A refused message is counted as `window-source` (`pod.dropped`, `message:dropped`). What an accepted window sends unsigned is delivered with `authenticated: false`, as before; a signature must still verify. The hello a child posts to its parent now goes to `targetOrigin` (default: the single configured origin, otherwise `'*'`) and only a configured parent window can answer it. `bootHostedPod()` passes `window: { parent: true }`.

Breaking default: with no `window` option nothing is accepted from another window. Previously any window could post to the pod and was heard (unsigned messages accepted by default), and any window could answer the parent handshake. A page that relied on that sets `window`. Pods on older versions are unaffected on the wire: nothing new is sent.
