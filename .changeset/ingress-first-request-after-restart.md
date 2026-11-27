---
"@johnhenry/browsermesh-ingress": patch
"@johnhenry/browsermesh-apps": patch
---

The first request after a pod starts over is answered instead of being cut with a 502 `provider-closed`. A visitor's request can reach the ingress after the pod's new connection has been answered and before the ingress has been told the pod started over, so it is sent on the old link; the link then ends (the send on the swapped connection fails, or the restart is reported) and the request ended within a few milliseconds. The ingress now sends such a request once more on the new link when it had no answer byte, was not streaming a body, and is a method that may be repeated (`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`; a request that never left may also be any other method with no body). It is on without `retry`, `retry.nonIdempotent` does not widen it, and an answer that has begun is never sent again. Nothing new on the wire; an older pod is sent the same request it would have been sent.

`@johnhenry/browsermesh-apps`: `link.request(method, params, { onSent })` (and the protocol channel's `request`) calls `onSent` once the transport has taken the first frame of the request, so a caller can tell a request that never left from one that may have reached the peer. Additive; a peer that does not pass it is unchanged.
