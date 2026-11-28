# @johnhenry/browsermesh-ingress

## 0.9.0

### Minor Changes

- eb6d632: Uploads: a bounded wait for a slot, and an early cut of an upload that cannot finish (#472). Behaviour changes, both applied by the ingress and by the pod on its own:

  - A request with a body that finds every upload slot on a pod link busy no longer gets the 503 `provider-uploads` at once: it waits in a FIFO queue for at most `uploadQueueMs` (default 2000) with at most `uploadQueueMax` (default 8) waiting; beyond either bound the 503 is as before (`0` turns the wait off). A client's queued uploads count against `maxUploadsPerClient`; a queued request whose client disconnects leaves at once. New CLI flags `--upload-queue` and `--upload-queue-max` (config keys `uploadQueue`, `uploadQueueMax`). The pod's `serveHttpOnMesh` takes the same two limits.
  - After the 30 s grace, an upload whose remaining bytes cannot arrive before the upload deadline at its observed rate (bytes received over the time spent waiting on the sender, so a slow origin is not counted) is cut at once with a new 408 `upload-too-slow`, instead of holding its slot until the deadline. A declared `Content-Length` that cannot be sent in the whole deadline even at `uploadMaxBytesPerSec` (default 256 MiB/s) is refused unread with a new 413 `upload-exceeds-deadline`. An upload that can finish is never cut; a chunked upload keeps only the existing 1 KiB/s floor.

### Patch Changes

- bc12a8c: The Node listener's `501 Not Implemented` for a method token Node's HTTP parser does not know now has a body (and the reason `method-not-implemented`) that lists the methods the listener carries (`http.METHODS`) and says the programmatic `handle()` carries any RFC 9110 method token. The standard set is the decided scope of the listener; the README's failure table and `docs/security.md` list the case (#471).
- 8818111: The CLI no longer refuses an option value that starts with `--`: a pod id is base64url text and about one in four thousand begins with `--`, so `--names-allow <id>=*` failed with "needs a value" for those. In the separate form an option's value is now the next argument whatever it starts with; it counts as missing only at the end of the arguments or when the next argument is itself a known option. `--option=value` is documented as the form that is safe for any value, and the README examples use it for `--map` and `--names-allow` (#470).

## 0.8.1

### Patch Changes

- cb4e1e3: The first request after a pod starts over is answered instead of being cut with a 502 `provider-closed`. A visitor's request can reach the ingress after the pod's new connection has been answered and before the ingress has been told the pod started over, so it is sent on the old link; the link then ends (the send on the swapped connection fails, or the restart is reported) and the request ended within a few milliseconds. The ingress now sends such a request once more on the new link when it had no answer byte, was not streaming a body, and is a method that may be repeated (`GET`, `HEAD`, `OPTIONS`, `PUT`, `DELETE`; a request that never left may also be any other method with no body). It is on without `retry`, `retry.nonIdempotent` does not widen it, and an answer that has begun is never sent again. Nothing new on the wire; an older pod is sent the same request it would have been sent.

  `@johnhenry/browsermesh-apps`: `link.request(method, params, { onSent })` (and the protocol channel's `request`) calls `onSent` once the transport has taken the first frame of the request, so a caller can tell a request that never left from one that may have reached the peer. Additive; a peer that does not pass it is unchanged.

## 0.8.0

### Minor Changes

- 5a4f849: **BREAKING DEFAULT: every method and a full, streamed request body are now on by default.** Until now a public address carried `GET` and `HEAD` (an operator could opt in to a few more, with a 64 KiB body read whole). With both ends on this version, a visitor's `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` and any other method token (`PURGE`, `PROPFIND`, ...) now reaches the pod's handler with its whole body streamed end to end, and **a pod that served `GET`/`HEAD`-only mappings now accepts writes** once the ingress in front of it is also on this version. Whatever the origin accepts for a writing method is reachable from the public address; cookies and `Authorization` are passed exactly as for a `GET` (only the headers the operator names). To keep `GET` and `HEAD` only, narrow either end: `serveHttpOnMesh(..., { methods: ['GET', 'HEAD'] })`, `createMeshIngress({ methods: ['GET', 'HEAD'] })`, or `--allow-methods GET,HEAD`. See "What changes on upgrade" in the README.

  - **Methods.** Any RFC 9110 method token; `CONNECT`, `TRACE` and `TRACK` are always refused (405 with `Allow`). `OPTIONS`, a preflight too, is passed to the pod like any other method. The Node listener carries the methods Node's parser knows (`http.METHODS`) and answers any other token 501; `handle(request)` carries any token.
  - **Streamed bodies, with backpressure both ways.** `Content-Length` and chunked; nothing holds a whole body (a body is held only for a pod that has not upgraded, a signed request, and a request `retry` may repeat, up to 1 MiB). The handler's `request.body` is the stream (and `Content-Length` when declared). Request trailers are dropped. `Expect: 100-continue` is answered once the ingress is ready to read, and not at all to a client that is refused. A visitor that disconnects mid-upload errors the pod's body and aborts the handler's `signal`; an answer that comes before the upload ends is delivered and the upload is stopped (the connection is closed after a bounded drain).
  - **Pod options.** `serveHttpOnMesh(service, handler, { methods, maxBodyBytes })`, per service too (`services: { api: { fetch, methods, maxBodyBytes } }`); `methods: [...]` narrows, and the ingress cannot widen it. New `limits`: `maxUploads` (4), `uploadTimeoutMs` (5 min), `bodyIdleMs` (10 s).
  - **Ingress options.** `createMeshIngress({ methods })` (default every method; a list narrows), CLI `--allow-methods` (`*` or a list), `--max-body` (default 32m, `unlimited` only by choice), `--max-uploads`, `--upload-timeout`. New `limits`: `maxRequestBodyBytes` is now 32 MiB and is streamed (it was a 64 KiB buffer), `maxBufferedBodyBytes` (1 MiB), `uploadTimeoutMs` (5 min), `maxUploadsPerProvider` (4). New failure: 503 `provider-uploads`. The Node listener's default `requestTimeoutMs` is 300 s (it was 60 s).
  - **Headers a pod can defend itself with (a default change).** `Origin`, `Referer` and `Sec-Fetch-Site`, `-Mode`, `-Dest` and `-User` are now forwarded to the pod by default (the visitor's browser sets them; they are not credentials, and a client that is not a browser can set them to anything). Cookies and `Authorization` stay opt-in. A pod that guards writes against other sites' pages can now see what it needs.
  - **One client cannot hold the upload slots.** An address has at most 2 uploads in flight (`maxUploadsPerClient`, new 429 `client-uploads`) of the 4 a pod's link takes, and an upload must keep a minimum rate (after 30 s, 1 KiB/s over each 10 s window spent waiting on the sender) at both ends or it ends with a 408. A pod in a runtime that cannot stream a request body holds it whole, up to `limits.maxHeldBodyBytes` (8 MiB) on at most 2 uploads, and says so in `capabilities`. Tiny chunks are joined (a few frames, a few blocks), the connection of an early-answered upload is closed once the client has sent its body, and a version 2 pod that does not answer `capabilities` is held to what version 1 carries.
  - **Bounds on both ends.** Body bytes (32 MiB each, refused unread when the length is declared, cut at the cap when it is not), idle time between chunks, total time, and concurrent uploads per pod link are enforced by the ingress and, separately, by the pod.
  - **Wire (negotiated).** Protocol `http` version 2: the ingress offers `[2, 1]`, a pod serves `[1, 2]`. Version 2 adds method tokens and an optional `length` in the `fetch` head, a streamed request body, and a `capabilities` request (what the pod accepts, per service, asked once per link and only for a request with a body or a method other than `GET` and `HEAD`). An older pod behind this ingress is spoken to in version 1: `GET` and `HEAD` only (a visitor's `POST` is a 405), and it is never sent a `capabilities` request, a new head field or a body stream it does not know (an operator's own explicit `methods` list keeps working for the standard methods in it, the body held whole). A pod on this version behind an older ingress is spoken to exactly as before and says nothing new on the wire.

## 0.7.0

### Minor Changes

- 0ec7933: A request in flight when a pod is torn down in the README's order is ended at once with a status and a reason, instead of waiting for its deadline. `serveHttpOnMesh(...).stop()` now returns a promise that resolves once the close notices of its `http` channels have left the pod (it used to return before they were sent, and the node's close that followed lost them, so the ingress was never told); `await` it before closing the node (README, "Closing a pod: the order", now says so). New option `stop({ graceMs })` (default 0, unchanged behaviour: end everything now) lets the requests being answered finish first, for at most `graceMs`; a request that arrives meanwhile is refused and the visitor gets 503 `provider-stopping` (new reason, with `Retry-After`; an older ingress shows it as 502 `provider-failed`). `openNameClient(...).close()` also waits for its channel's close notice. Apps: a protocol channel's `close()` returns a promise that settles (never rejects) once the notice to the other end has left; callers that ignore the return value are unaffected, and an older apps gives `undefined`, which `stop()` and `close()` accept (they then have nothing to wait for).

### Patch Changes

- c7c6cda: A node whose peer starts over on the WebRTC connection it holds open (a fresh offer for an open connection: a page loaded again, a node made anew) now ends the channel link that ran over the old connection. Before, the link stayed: a restarted pod that only serves (a hand `--map` at the ingress, no name claimed) sends no hello of its own, so the ingress went on sending over a link the new node knows nothing of, and every request waited out the open timeout for a 504 `provider-timeout`. Now the requests on the old link end at once (502 `provider-closed`) and the next request opens a new link on the new connection. `onIncomingConnection` gets a fourth argument `{ restarted }`, `adoptIncomingSession` takes `{ restarted }` and emits `peer:transport-restart`, and the mesh channel service follows it. Nothing is added to the wire: an older pod is served as before, and an older ingress behaves as it did. The ingress README says so.

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
