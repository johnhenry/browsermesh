# @johnhenry/browsermesh-ingress

## 0.6.0

### Minor Changes

- fc52951: Closing a names client says goodbye, the record of a request names the service, and a pod that restarts or dials at the same time as the ingress is served.

  - **`openNameClient(...).close()` gives the names up at once.** It asks the ingress (`bye`, a new request of the `ingress-names` protocol that an older ingress answers "unknown method") to release what the channel claimed, waits for the answer (`closeTimeoutMs`, default 2000, so an ingress that never answers cannot hold a pod up) and closes the channel with the reason `done`; it now returns a promise, and a pod closes it with `await client.close()` before its node. The ingress reads a close with the reason `done` as a goodbye and releases, where a channel that is lost (the link dropped, or a plain `channel.close()`) is held for `holdMs` as before, so nothing is held, dialled or waited for in the 30 s after a pod that said it was leaving. `createNameTable().linkLost(pod, link, { hold: false })` and `release(pod, label, { link })` are the table's side. An older ingress holds the names as it always did; an older pod's `close()` already sent `done`, and a new ingress reads it as a goodbye. The README documents the order to close a pod in.
  - **The record of a request names the service.** The audit record (`onAudit`) has `service` next to `host` when the route names one, and the CLI prints it after the pod (`GET site.example.test -> <podId>#web 200 ...`); a route with no service records and prints exactly what it did. The handler of `serveHttpOnMesh` already finds the name in `ctx.service`; `fromSiteHandler` now passes it on as the `service` field of the request object its site handler receives.
  - **Restarts and crossing dials are fixed in `@johnhenry/browsermesh-apps` 0.28** (a pod that stops and starts again against a running ingress is answered whole, and a hand mapping with the CLI's default dialling no longer fails until both dials time out); the ingress's tests run 20 stop/start cycles over real WebRTC against the CLI. With an older apps the ingress works as it did.

## 0.5.0

### Minor Changes

- 4af3c21: New `listenNode` option `halfClosedClients` (off by default; nothing existing changes). With it, a client that has sent its whole request and then finished sending (`nc -N`, `shutdown(SHUT_WR)`) is answered: the connection stays open for the answer and ends after the response, bounded by `limits.timeoutMs`. Without it, as before, Node's HTTP server treats the client's end of file as a hang-up and an answer that is not ready is lost. It is off because a client's end of file is also all that Firefox and WebKit send when a fetch is aborted, and with the option on that no longer aborts the page's handler until `limits.timeoutMs`.

## 0.4.0

### Minor Changes

- 0b7c150: Four additions for an ingress that fronts pods which come and go. Each is optional and off unless used; nothing that exists changes.

  - **Names a pod may claim.** `createNameTable`, `serveIngressNames`, `openNameClient` and `registryAllow`, and CLI flags `--names-zone`, `--names-allow`, `--names-deny`, `--names-max`, `--names-max-per-pod`, `--names-hold`. A pod that holds the grants `protocol:ingress-names:open` and `ingress:name:<label>:claim` may claim a plain DNS label under the operator's zone for as long as its link is up. A name another live pod holds is never given out, a name stays its holder's for a short hold after the link drops, labels with hyphens in the third and fourth places and a deny-list of confusing labels are refused, and names per pod, per zone and claims per minute are bounded. New protocol `ingress-names` v1; an older ingress does not serve it and an older pod never opens it.
  - **Several services on one pod.** `serveHttpOnMesh(..., { services })` declares named services, a route names one (`{ peer, service }`, CLI `--map HOST[/PREFIX]=PODID#SERVICE`). The `fetch` head may carry `service`, and a pod that declares services answers one more request, `services`. An older pod answers "unknown method" and a route that names a service is refused (502 `provider-no-service`) instead of being sent to its one handler.
  - **The first request.** `ingress.expect(podId)` (the CLI does it for every mapped pod) dials a pod at start and keeps dialling; a request for it that arrives before the link is up waits, bounded by `limits.linkWaitMs` (5 s, CLI `--link-wait`) and by its own deadline, instead of failing. `ingress.readiness()`, `whenReady()` and `listenNode(..., { readyPath })` (CLI `--ready-path`) say when the routes are live.
  - **The README says plainly what an ingress operator can see and change**, that there is no end-to-end confidentiality from the operator, and what would be needed for TLS passthrough (not built).

## 0.3.1

## 0.3.0

### Minor Changes

- 973b555: The provider's and the ingress's hooks are told what is verified about the link a request came over, and a helper binds a request's signer to that link.

  - `serveHttpOnMesh`: `allowFrom` (when a function) and `verifyRequest` get one more, trailing argument, a `peer` object `{ podId, verified, keyId?, publicKey? }`. `verified` is `'bound'` (a direct WebRTC connection whose peer proved the key behind its pod id), `'wsh'` (a wsh peer link), `'key'` (both at once) or `'none'` (nothing was proven: an unbound WebRTC connection, a relayed or otherwise vouched-for link, any other transport, or no node given). `keyId` (the pod id, the hash of the key) and `publicKey` are present only when something was proven. The existing context objects and their `peer` string are unchanged, so a hook written for the old shape is called exactly as before.
  - Where the link's identity is read from: `serveHttpOnMesh(..., { node })` (a `createMeshNode` result; `nodeLinkIdentity(node)` is exported) or your own `linkIdentity(podId)`. With neither, `verified` is always `'none'`: nothing is guessed. A source can only narrow, and a node counts a link as proven only when every live session to the pod proves it.
  - `requireLinkKey(verifySigner)`: a ready-made `verifyRequest` that accepts a request only when the link proved a key and the key that signed the request (the verified key or key id your `verifySigner` returns) is the link's key. A refusal is the existing `request-unverified` one and its reason (`link-unverified`, `signer-unverified`, `signer-key-invalid`, `link-key-mismatch`) goes to `onLog` and `stats().refusals`. Off unless used.
  - `createMeshIngress`: `signRequest` and `verifyResponse` get the same `peer` object for the provider's link as a trailing argument (`linkIdentity`, or a `node` that is a mesh node); `requireLinkKey` works for `verifyResponse` too.
  - Type declarations (`src/index.d.ts`, `src/node.d.ts`) are now shipped.

  Nothing on the wire changes and an older peer is unaffected.

## 0.2.1

## 0.2.0

### Minor Changes

- 819f725: Options a first adoption needed; each is off or unchanged by default, except the one marked as a default change.

  - **Default change (a 0.x minor): the forced `Content-Security-Policy` is now `default-src 'none'; frame-ancestors 'none'; sandbox`.** A response the ingress serves is never framed by default. A mapping's own `contentSecurityPolicy` option (a string, or `false`) replaces or removes it, as before; code that compared the old default string must be updated.
  - `serveHttpOnMesh`'s `allowFrom` also accepts a function `(podId, context) => boolean | Promise<boolean>`, for an ingress whose pod identity is new each session. It is still required (omitting it is an error), is asked on open and for every request, and only `true` serves (a throw or a rejection refuses). With a function the provider's own check carries the weight. New provider hook `verifyRequest(request, context)` runs before the handler and can refuse; new ingress option `signRequest(bytes, { peer })` is its counterpart, symmetrical to `sign` / `verifyResponse`. New export `signedRequestBytes`. A refusal is a 502 `provider-refused-request`; a failing `signRequest` is a 500 `sign-error`. The package picks no cryptography.
  - `response.addHeaders` in a mapping adds headers the operator wrote (at most 16, no line breaks, no hop-by-hop or framing header, never a forced header unless that header's own opt-out is set); a bad one is a 500 `bad-mapping`.
  - `declineRequest()` lets a provider say "not me, try another": the ingress reports the named 502 `provider-declined` and never sends it as the provider's own response. New ingress option `retry: { attempts, on, nonIdempotent }` calls `resolve` again, with `{ attempt, tried }`, after `provider-unreachable`, `provider-pin-mismatch` or `provider-declined`: bounded to 1 to 5 more attempts under one deadline, each authorised and audited on its own (the audit record gains `attempt`, and `retried: true` when handed on; `stats().retries`), never after a provider started answering, and `POST` and `PATCH` only with `nonIdempotent: true`. `resolve` now receives `{ attempt: 0, tried: [] }` as a second argument.
  - Documentation: one table of the headers that cross by default and how to forward `authorization` and cookies or expose CORS headers deliberately, one table of every status and reason the ingress produces (a test pins it to the code), that the protocol channel needs only a byte duplex with a peer identity (so it can ride a relayed link, where the signed hooks should be mandatory when the peer identity is asserted by a third party), and that there is no multi-hop delivery.

  Wire: the `fetch` head gains an optional `sig` and the answer an optional `declined`; both are ignored by an older peer (an older provider does not verify a signed request; an older ingress shows its client an empty 421 for a decline).

## 0.1.0

### Minor Changes

- 9704e62: A new package: real HTTP in, a mesh pod answers.

  `createMeshIngress({ service | node, resolve, authorize?, deny?, limits?, methods?, ... })` returns a web-standard `handle(request: Request): Promise<Response>` (no `node:` import: it runs in Node, Deno, Bun and Workers) that forwards each request to the one pod a mapping names, over a new protocol `http` (version 1) on the protocol channel, with bodies as protocol streams (credit-based backpressure, cancellation). `serveHttpOnMesh(service, handler | { fetch }, { allowFrom, limits })` is the provider side: a browser tab or a pod answers with a `(Request) => Response` handler, to the ingress pods it names and that hold `protocol:http:open` (default deny). `fromSiteHandler` serves an existing serverless site handler over `http`, and an opt-in `rpc` option lets the ingress reach a provider that does not serve `http` through one buffered mesh-rpc request.

  - The answer is accepted only from the pod the mapping names (the channel's verified peer); routed (multi-hop) delivery is not part of this version and is refused with a named reason. Optional signed responses.
  - Safe defaults, each with a test: GET and HEAD only, a 64 KiB request body cap, response cap, total deadline, slow-body and idle timeouts, global, per-client and per-provider in-flight and rate limits, hop-by-hop, `Host`, `Forwarded`, `X-Forwarded-*`, `Upgrade` and `Proxy-*` headers never forwarded, `Set-Cookie` stripped, `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store` forced unless a mapping opts out, redirects never followed, an audit record without query strings or bodies, and no WebSocket upgrade (426).
  - `@johnhenry/browsermesh-ingress/node`: `listenNode(ingress, { port, host = '127.0.0.1', trustProxy = false })`, loopback unless `public: true`.
  - A `browsermesh-ingress` command: `--listen`, `--signaling`, `--map host=podId`, `--allow-methods`, `--max-body`, `--timeout`, `--auth bearer:<file>`, `--identity`, `--config`; it refuses a non-loopback bind without `--public --tls-terminated-in-front` and refuses two different pods under one hostname. It needs `node-datachannel` (an optional dependency) to reach pods over WebRTC.

  Nothing on the wire changes for existing packages: a peer that does not serve `http` answers the open with `unknown-protocol` and is sent nothing else.
