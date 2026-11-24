---
'@johnhenry/browsermesh-ingress': minor
---

A new package: real HTTP in, a mesh pod answers.

`createMeshIngress({ service | node, resolve, authorize?, deny?, limits?, methods?, ... })` returns a web-standard `handle(request: Request): Promise<Response>` (no `node:` import: it runs in Node, Deno, Bun and Workers) that forwards each request to the one pod a mapping names, over a new protocol `http` (version 1) on the protocol channel, with bodies as protocol streams (credit-based backpressure, cancellation). `serveHttpOnMesh(service, handler | { fetch }, { allowFrom, limits })` is the provider side: a browser tab or a pod answers with a `(Request) => Response` handler, to the ingress pods it names and that hold `protocol:http:open` (default deny). `fromSiteHandler` serves an existing serverless site handler over `http`, and an opt-in `rpc` option lets the ingress reach a provider that does not serve `http` through one buffered mesh-rpc request.

- The answer is accepted only from the pod the mapping names (the channel's verified peer); routed (multi-hop) delivery is not part of this version and is refused with a named reason. Optional signed responses.
- Safe defaults, each with a test: GET and HEAD only, a 64 KiB request body cap, response cap, total deadline, slow-body and idle timeouts, global, per-client and per-provider in-flight and rate limits, hop-by-hop, `Host`, `Forwarded`, `X-Forwarded-*`, `Upgrade` and `Proxy-*` headers never forwarded, `Set-Cookie` stripped, `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` forced unless a mapping opts out, redirects never followed, an audit record without query strings or bodies, and no WebSocket upgrade (426).
- `@johnhenry/browsermesh-ingress/node`: `listenNode(ingress, { port, host = '127.0.0.1', trustProxy = false })`, loopback unless `public: true`.
- A `browsermesh-ingress` command: `--listen`, `--signaling`, `--map host=podId`, `--allow-methods`, `--max-body`, `--timeout`, `--auth bearer:<file>`, `--identity`, `--config`; it refuses a non-loopback bind without `--public --tls-terminated-in-front` and refuses two different pods under one hostname. It needs `node-datachannel` (an optional dependency) to reach pods over WebRTC.

Nothing on the wire changes for existing packages: a peer that does not serve `http` answers the open with `unknown-protocol` and is sent nothing else.
