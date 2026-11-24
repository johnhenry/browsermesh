---
"@johnhenry/browsermesh-apps": minor
---

`ServerSharing` and `createProxyHandler()` build the upstream request target from parsed parts and keep it on the configured origin.

- The target is the configured origin plus a path and query from the peer. The path must begin with a single `/` and may not contain a scheme, authority, backslash, whitespace, control character or fragment; the resolved origin must equal the configured one, otherwise the request is refused (400) and nothing is sent.
- Peer requests to `ServerSharing` must pass `registry.checkAccess(peerKey, 'server-share:<name>', 'request')`, with `peerKey` the key of the session the message arrived on. New option `registry` (on `ServerSharing` and `createMeshRoutingService()`). Without a registry, peer requests are refused (403); a `handleRequest(request)` call with no second argument is an in-process call and is unchanged. Grant with `registry.grantCapabilities(peer, ['server-share:<name>:request'])`.
- Methods, request headers, header count and size, request body size, response size and request time are bounded, with options (`allowedMethods`, `allowedRequestHeaders`, `maxRequestBodyBytes`, `maxResponseBytes`, `maxHeaderCount`, `maxHeaderBytes`, `requestTimeoutMs`) and defaults listed in the README. `Host`, hop-by-hop headers, `Cookie` and `Authorization` are not taken from a peer; `expose(port, name, { headers })` sets headers the sharer chooses to send. Share names may not contain `:` or `*`.
- Redirects from the upstream are not followed; the 3xx response is returned as it is. A response larger than the bound is refused (502), never truncated.
- A proxy response is accepted only from the peer the request was sent to.

Behaviour change to note: a host that used `createMeshRoutingService({ fetchFn })` without a registry now refuses every peer request until it passes `registry` and grants the scope.
