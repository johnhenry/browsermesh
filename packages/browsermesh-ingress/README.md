# browsermesh-ingress

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-ingress.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-ingress)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-ingress.svg)](LICENSE)

Real HTTP in, a mesh pod answers. A request arrives at a listener you run; a mapping you wrote names ONE pod; that pod
(a browser tab, or a pod in Node or anywhere else that runs `serveHttpOnMesh`) answers it with a
`(Request) => Response` handler; the response goes back to the HTTP client.

It is a library (a web-standard `(Request) => Promise<Response>`, plus a Node listener on its own entry) and a CLI
(`browsermesh-ingress`).

Peer dependency: `@johnhenry/browsermesh-apps` `>=0.21.0` (the protocol channel and its streams). The CLI also needs
`@johnhenry/browsermesh-core`, `-pod`, `-primitives`, `-transport` and `-discovery` (optional dependencies, installed by
default) and `node-datachannel` (an optional dependency) to reach pods over WebRTC from Node.

## What it is, and what it is not

- **It is** a bounded request forwarder: one mapping, one pod, protocol `http` v1 on the existing protocol channel
  (`openProtocol(peer, 'http', { versions: [1] })`), request and response bodies as protocol streams with
  cancellation and backpressure.
- **It is not a CDN**: nothing is cached (`Cache-Control: no-store`), nothing is replicated.
- **It is not a file server**: it holds no content and serves none; the pod does.
- **It is not an egress proxy**: it never fetches a URL, and a peer never supplies one. (`ServerSharing` in
  `browsermesh-apps` goes the other way, a peer asking this pod to fetch from a local server; it is separate.)

## The security model, plainly

**An ingress operator serves content they do not control.** The pod behind a mapping answers with whatever it likes; the
HTTP client is anyone. The ingress sits between them and does only translating and limiting:

- the answer is accepted only from the pod the mapping names (a channel bound to another pod is refused, 502
  `provider-pin-mismatch`; a pod with no direct link is refused, 502 `provider-unreachable`);
- the provider decides whom it serves (`protocol:http:open` in its registry, default deny, and `allowFrom`);
- every dimension is bounded (see Defaults) and everything a provider sends is filtered: no cookies, no redirects off
  the origin, no headers outside an allow-list, an inert `Content-Security-Policy`.

**One origin per provider is your responsibility.** Two providers behind one hostname share cookies, storage and script
reach in a browser; the response policy reduces that and must not be relied on. Give each pod its own hostname. The CLI
refuses two different pods under one hostname, and warns when mappings share an origin by path.

The listener speaks plain HTTP: put TLS in front of it. Nothing public is on by default.

## Library

```js
import { attachService, createMeshProtocolService } from '@johnhenry/browsermesh-apps'
import { createMeshIngress } from '@johnhenry/browsermesh-ingress'
import { listenNode } from '@johnhenry/browsermesh-ingress/node'

const service = attachService(node, undefined, createMeshProtocolService())
const ingress = createMeshIngress({
  service,                                                   // or `node`, to have one attached
  resolve: (request) => new URL(request.url).host === 'app.example.test' ? { peer: appPodId } : null,
  methods: ['GET', 'HEAD', 'POST'],                          // GET and HEAD by default
  onAudit: (record) => console.log(record),                  // { peer, host, method, status, reason?, requestBytes, responseBytes, durationMs }
})
const { port, close } = await listenNode(ingress, { port: 8080, host: '127.0.0.1', trustProxy: false })

// anywhere else: a Workers or Deno handler is just
//   export default { fetch: (request) => ingress.handle(request, { clientAddress }) }
```

`createMeshIngress({ node | service, resolve, authorize?, deny?, limits?, methods?, forwardHeaders?, exposeHeaders?,
forwardClientAddress?, verifyResponse?, signRequest?, linkIdentity?, retry?, rpc?, onAudit?, clock? })` returns
`{ handle(request, { clientAddress }), stats(), close() }`.

- `resolve(request, { attempt, tried }) -> Promise<{ peer, path?, headers?, response? } | null>`: `peer` is the pod id the
  answer is pinned to; `path` replaces the request's path (the query is kept); `headers` are added to what the provider
  is sent; `response` is `{ contentSecurityPolicy, cacheControl, allowSetCookie, addHeaders }` to opt this mapping out of
  the response policy or to add headers you author (`nosniff` is not optional). `null` is a 404. The second argument is
  `{ attempt: 0, tried: [] }` unless `retry` is set (see Retry).
- `authorize(request, target) -> boolean`: anything but `true` is a 403. `deny(request) -> Response | true | null`: a
  Response is sent as it is, `true` is a 451.
- `limits`: see Defaults. `verifyResponse({ peer, bytes, sig, request })`: signed responses (below).
- `rpc`: a `createMeshRpcService` api on the site service's envelope type; with it the ingress asks a provider that does
  not serve `http` (it said so, or never answered the open) through one buffered mesh-rpc request, for a minute at a
  time. Off by default: the older service has no default deny of its own. A provider that refused the open is never
  asked this way.
- A hook never has to read the body: `resolve`, `authorize` and `deny` get the `Request` before it is read.

### The provider

```js
import { serveHttpOnMesh, fromSiteHandler } from '@johnhenry/browsermesh-ingress'

const served = serveHttpOnMesh(service, async (request, { peer, signal, client }) => new Response('hello'), {
  allowFrom: [ingressPodId],           // required: nothing is served to a pod that is not named
  limits: { maxInflight: 16, maxRequestBodyBytes: 1024 * 1024, maxResponseBytes: 8 * 1024 * 1024, handlerTimeoutMs: 30_000 },
})
node.registry.grantCapabilities(ingressPodId, ['protocol:http:open'])   // the registry grant is required too
// served.stop(); served.stats()
```

`handler` is a function or `{ fetch }`. `peer` is the ingress pod, the pod id the channel is addressed by (never a header);
whether that id was proven on the link is a separate question, answered by the `peer` object the hooks get (next
section). `signal` aborts when the client goes away or the deadline passes. `request.url` is `http://<the client's host><path>`.
A request body is read whole (bounded) before the handler runs, so it works in every browser; response bodies stream.

**`allowFrom` is required, and is a list or a function.** A list names the ingress pod ids served. A function
`(podId, context, peer) => boolean | Promise<boolean>` (`context` is `{ peer, protocol, version }`; `peer` is what is verified
about the link, below) is for an ingress whose pod identity is new each session and so cannot be listed: it is asked on open
and again for every request, and only `true` serves (anything else, a throw or a rejection refuses; the handler never runs).
Omitting `allowFrom` is still an error.
**With a function, your own check carries the weight**: the registry grant and the pod id alone no longer say which ingress
this is, so decide by another proof, for example a signed request (`verifyRequest`, below) whose signer is bound to the link
(`requireLinkKey`, below).

### Who is at the other end of the link: `peer`, `verified`, `requireLinkKey`

The channel says which pod id a session is addressed by. Whether that id was **proven** on the link depends on the
transport underneath, and the channel does not carry it. So the provider's `allowFrom` (when a function) and `verifyRequest`
get one more argument, a `peer` object, and the ingress's `signRequest` and `verifyResponse` get the same for the provider's
link:

```js
// peer: { podId, verified, keyId?, publicKey? }
serveHttpOnMesh(service, handler, {
  node,                                                         // a mesh node (createMeshNode): where the link's identity is read from
  allowFrom: (podId, context, peer) => peer.verified !== 'none',
  verifyRequest: (request, { peer, sig, bytes, rid, nonce }, peerObject) => boolean,
})
createMeshIngress({ ..., node /* or linkIdentity */,
  signRequest: (bytes, { peer }, link) => signature,
  verifyResponse: ({ peer, bytes, sig, request }, link) => boolean,
})
```

Compatibility: it is an extra **trailing argument**; the context objects (`{ peer, sig, bytes, rid, nonce }`, `{ peer, protocol,
version }`, `{ peer }`) are unchanged, `peer` in them is still the pod id string, and a hook that takes fewer parameters is
called as before. Nothing new is sent on the wire; an older peer is unaffected.

`peer.verified` says how the identity was established **on this link**; `keyId` and `publicKey` are present only when something
was proven, and never otherwise:

<!-- link-identity-table:begin -->
| Link to the peer | `verified` | What is proven |
| --- | --- | --- |
| Direct WebRTC, identity binding on (the `createMeshNode` default) | `bound` | the peer proved possession of the key behind its pod id, over the DTLS fingerprints of both session descriptions, on this connection |
| A wsh peer link | `wsh` | the peer logged in with the key its pod id is the hash of, the dialler pinned the host key to the pod id it meant to reach, the session is sealed |
| Both of those at once | `key` | each is key-proven; which one carried a given frame is not recorded |
| WebRTC with the binding off, or an unbound peer (`webrtcIdentityBinding: false`, `webrtcAllowUnboundPeers`) | `none` | nothing: the pod id is the one the session was addressed by |
| A relayed or otherwise vouched-for link, any other transport, no session, a node this package was not told about | `none` | nothing; `keyId` and `publicKey` are absent |
<!-- link-identity-table:end -->

A pod id is the base64url SHA-256 of the pod's Ed25519 public key, so where the id is proven the key's hash is proven with it:
`keyId` is that value (equal to `podId`). `publicKey` (the 32 raw bytes) is present only when the source of the link's identity
supplied it and it hashes to `podId`; the built-in sources do not supply it. Multi-hop (routed) delivery does not carry this
protocol (see below), so it has no row. **A provider that needs the request's signer bound to the link must refuse a link whose
`verified` is `none`**: `requireLinkKey` does.

Where the information comes from: pass `node` (a `createMeshNode` result; `nodeLinkIdentity(node)` is the function it uses) or
your own `linkIdentity: (podId) => ({ verified: 'bound' | 'wsh' | 'key', publicKey? }) | undefined`. A source can only
narrow: anything that is not a clear proof, a throw, or a public key that does not hash to the pod id is `none`. With neither,
`peer.verified` is always `none` (nothing is guessed). `nodeLinkIdentity` reports a proof only when **every** live session to
that pod carries one (a frame may have arrived on any of them), and asks again on each request. `createMeshIngress` reads its
`node` the same way when that is a mesh node.

**Binding a request's signer to the link.** A request signature on its own shows that the request was not altered and that the
holder of the signing key made it. With `requireLinkKey` it must also be the pod on the other end of the link:

```js
import { serveHttpOnMesh, requireLinkKey } from '@johnhenry/browsermesh-ingress'

serveHttpOnMesh(service, handler, {
  node,                                   // so the hooks can tell what the link proved
  allowFrom: (podId, context, peer) => peer.verified !== 'none',
  // verifySigner does the signature check you already do, and returns the key that made it
  // (the 32 raw bytes, or the key id: base64url SHA-256 of the key), or a falsy value.
  verifyRequest: requireLinkKey(async (request, { sig, bytes }) => verifyAndReturnSignerKey(sig, bytes)),
})
```

`requireLinkKey(verifySigner)` returns a `verifyRequest` hook (it works as `verifyResponse` too: it reads the `peer` object from
its last argument). It accepts only when the link proved a key and the signer's key hashes to the link's `keyId`. Otherwise the
request is refused as `request-unverified` (the client sees 502 `provider-refused-request`, as for any `verifyRequest` that says
no) and the handler never runs; the reason is named on the provider side: `link-unverified` (the link proved nothing),
`signer-unverified` (your check said no or threw), `signer-key-invalid` (not a 32-byte key or a key id) or `link-key-mismatch`
(the signer is not the link's key). Each goes to `onLog` as `http:request-refused` and is counted in `stats().refusals`. It is
off unless you use it.

### Signed requests (optional)

`serveHttpOnMesh(..., { verifyRequest: async (request, { peer, sig, bytes, rid, nonce }, peerObject) => boolean })` runs before the
handler, on a clone of the request (the body is still the handler's to read), and can refuse: only `true` lets the request
through, and a refusal is a 502 `provider-refused-request` for the client. The ingress-side counterpart is
`createMeshIngress({ signRequest: async (bytes, { peer }) => signature })`, symmetrical to `sign` / `verifyResponse`.
The signed bytes (`signedRequestBytes()`) are the request's id and a fresh nonce, host, method and target, the headers as
sent, the client address when forwarded, and the SHA-256 of the body, marked as a request so they never double as a
response's. `bytes` is rebuilt by the provider from what arrived, so any change in transit fails the check. A provider that
wants signed requests only must itself refuse a request with no `sig` (the hook is called with `sig` undefined). A
`signRequest` that throws or returns no text is a 500 `sign-error` and nothing is sent. The package chooses no
cryptography; a provider that does not know `sig` ignores it, so an older provider simply does not verify. Whose key signed is
yours to establish; to require that it is the pod on the other end of the link, use `requireLinkKey` (above).

### Declining a request

A handler that cannot answer, and has done no work for the request, returns `declineRequest()` (exported) instead of a
response. The ingress surfaces it as the named failure `provider-declined` (502); it is **never** sent to the client as the
provider's own response. A handler that merely returns a 421 is giving an ordinary answer, which passes through. On the
wire a decline is `{ status: 421, headers: [], body: false, declined: true }`; an older ingress that does not know
`declined` shows its client a plain, empty 421.

### Retry (optional)

`createMeshIngress({ retry: { attempts: 2, on: ['provider-unreachable', 'provider-pin-mismatch', 'provider-declined'] } })`
(off by default; `on` defaults to all three, nothing else can be named). After one of those failures, which all happen
before a provider did any work, `resolve` is called again with `{ attempt, tried }`, the pod ids already tried, so it can
pick another; a mapping that returns `null` or a pod already tried ends the retries with the original failure. At most
`attempts` (1 to 5) more times, under the same single deadline. Every attempt is authorised (`authorize`), rate-limited and
audited on its own (the audit record has `attempt`, and `retried: true` for one that was handed on); `stats().retries`
counts them. Never after a provider started answering (its own error, a bad signature, a refused request, a stalled body)
and, for `POST` and `PATCH`, only with `retry.nonIdempotent: true`.

`fromSiteHandler(createSiteRequestHandler(siteConfig))` serves a serverless site (`browsermesh-apps`) over `http`
without rewriting it (wrap, not replace: the legacy service keeps working over mesh-rpc).

### Signed responses (optional)

`serveHttpOnMesh(..., { sign: async (bytes, { peer }) => signature })` and
`createMeshIngress({ verifyResponse: async ({ peer, bytes, sig }) => boolean })`. The signed bytes (`signedBytes()` in
the source) are the request's id and a fresh nonce, host, method and target, the status, the headers as the provider sent
them and the SHA-256 of the body; the provider buffers a signed response. A response with no signature, or one the hook
does not accept, is a 502 (`response-unsigned`, `response-signature-invalid`). The package chooses no cryptography.

## Headers, by default and on purpose

What crosses, with no option set (a test pins both lists to the code):

<!-- headers-table:begin -->
| Direction | Passed by default | Never, whatever you set |
| --- | --- | --- |
| Request, client to provider | `accept`, `accept-language`, `content-type`, `if-match`, `if-modified-since`, `if-none-match`, `if-unmodified-since`, `range` | `host`, `connection`, `keep-alive`, `proxy-*`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `content-length`, `expect`, `forwarded`, `x-real-ip`, `via`, `x-forwarded-*`, `x-original-url`, `x-rewrite-url` |
| Response, provider to client | `content-type`, `content-length`, `content-language`, `content-disposition`, `content-range`, `accept-ranges`, `etag`, `last-modified`, `location` (a path on this origin only), `vary`, `retry-after`, `allow` | `content-encoding` other than `identity` (a 502), and everything not listed, including `set-cookie`, CORS, HSTS, `refresh`, `link` |
<!-- headers-table:end -->

`Authorization`, `Cookie` and every other request header are **not** forwarded unless you name them; CORS and every other
response header are **not** exposed unless you name them. Do it deliberately, per ingress:

```js
createMeshIngress({
  service, resolve,
  forwardHeaders: ['authorization', 'cookie'],        // the provider now sees them: it must be a pod you trust with them
  exposeHeaders: ['access-control-allow-origin', 'access-control-allow-credentials', 'x-request-id'],
})
// or, for one mapping and values you author yourself (no line breaks, 16 at most, never the forced headers):
resolve: () => ({ peer, response: { addHeaders: { 'access-control-allow-origin': 'https://app.example' } } })
```

`forwardHeaders` and `exposeHeaders` apply to every mapping and let through whatever the provider or client sent;
`response.addHeaders` sets values you wrote for one mapping and replaces what the provider sent under that name. Names on
the never list stay refused. Forwarding `authorization` or `cookie` to a provider you do not fully trust hands it the
client's credentials; exposing `set-cookie` needs `allowSetCookie: true` in the mapping.

## Every failure the ingress produces

Each is a response with this status and an `x-browsermesh-ingress-reason` header carrying the reason (also in the audit
record and `stats().reasons`). A test pins this table to the code: a status and reason added or removed in the source
fails it until the table says so.

<!-- failures-table:begin -->
| Status | Reason | Failure mode |
| --- | --- | --- |
| 400 | `bad-framing` | `Transfer-Encoding` with `Content-Length`, a bad `Content-Length`, a body that is not the declared length |
| 400 | `bad-header-value` | a request header with a control character |
| 400 | `bad-headers` | a header the listener could not parse |
| 400 | `bad-host` | a `Host` that is not a plain hostname, or a URL with credentials |
| 400 | `bad-request` | a request the listener could not read |
| 400 | `bad-request-head` | (provider side) a malformed request head |
| 400 | `bad-stream` | a body stream that is not one this end expects |
| 400 | `bad-target` | a request target that is not an origin-form path |
| 400 | `body-on-get` | a body on `GET` or `HEAD` |
| 403 | `forbidden` | `authorize` said no (or, provider side, `allowFrom`) |
| 404 | `no-mapping` | `resolve` returned `null` |
| 405 | `method-not-allowed` | a method not in `methods` (with `Allow`) |
| 408 | `body-timeout` | the client's body stalled |
| 413 | `body-too-large` | the request body is over the cap |
| 414 | `target-too-long` | the target is over 2048 characters |
| 426 | `upgrade-unsupported` | a WebSocket or other upgrade |
| 429 | `client-inflight` | too many requests from this client in flight (with `Retry-After`) |
| 429 | `client-rate` | too many requests from this client in the window (with `Retry-After`) |
| 431 | `headers-too-large` | too many or too large request headers |
| 451 | `denied` | `deny` returned `true` |
| 499 | `client-aborted` | the client went away |
| 500 | `bad-mapping` | `resolve` named a bad pod id, path, header or response policy |
| 500 | `deny-error` | `deny` threw |
| 500 | `internal-error` | an unexpected failure inside the ingress |
| 500 | `resolve-error` | `resolve` threw |
| 500 | `sign-error` | `signRequest` threw or returned no text |
| 502 | `bad-content-encoding` | the provider sent a content coding that is not `identity` |
| 502 | `bad-response-head` | the provider's answer is not a well-formed head |
| 502 | `bad-response-length` | the body is not the length the provider declared |
| 502 | `bad-response-status` | a status outside 200-599 |
| 502 | `provider-closed` | the channel to the provider closed mid-request |
| 502 | `provider-declined` | the provider declined the request (`declineRequest()`), retryable |
| 502 | `provider-error` | the provider's handler failed (an internal error on its side) |
| 502 | `provider-failed` | the provider failed to answer |
| 502 | `provider-no-http` | the provider does not serve the `http` protocol |
| 502 | `provider-not-authorized` | the provider has not granted this ingress the protocol, or no longer does |
| 502 | `provider-pin-mismatch` | the channel is bound to another pod than the mapping names, retryable |
| 502 | `provider-redirect-refused` | a `Location` that is not a path on this origin |
| 502 | `provider-refused-body` | the provider would not take the request body |
| 502 | `provider-refused-request` | the provider's `verifyRequest` refused the request |
| 502 | `provider-unreachable` | no direct link to the provider (routed delivery is not supported), retryable |
| 502 | `provider-version` | no version of the protocol in common |
| 502 | `response-signature-invalid` | `verifyResponse` did not accept the signature |
| 502 | `response-too-large` | the response is over the cap |
| 502 | `response-unsigned` | `verifyResponse` is set and the response has no signature |
| 503 | `busy` | (provider side) too many bodies or requests waiting |
| 503 | `closing` | the ingress is shutting down |
| 503 | `overloaded` | the ingress is at its global in-flight cap (with `Retry-After`) |
| 503 | `provider-inflight` | this provider is at its in-flight cap (with `Retry-After`) |
| 503 | `provider-rate` | this provider is over its rate (with `Retry-After`) |
| 504 | `provider-idle` | the provider announced a body and did not send it, or stalled |
| 504 | `provider-timeout` | the whole request ran past `timeoutMs`, or the provider did not answer the open |
<!-- failures-table:end -->

A provider's own answer, including its own 4xx and 5xx and a plain 421, passes through with the policy headers applied.

## What carries it, and what it does not do

- The `http` protocol channel needs only **a byte duplex with a peer identity**: the channel is a protocol on the existing
  mesh link, so it rides whatever link the mesh has to the pod, a direct WebRTC channel, a WebSocket, or a relayed link,
  as long as each message arrives from the peer the link says it is.
- **On a link whose peer identity is only asserted by a third party** (a relay that vouches for who is on the other end,
  rather than a key both ends checked), the pod id the ingress and the provider see is only as good as that third party; the
  `peer.verified` of such a link is `none`. There the signed-response (`sign` / `verifyResponse`) and signed-request
  (`signRequest` / `verifyRequest`) hooks should be mandatory in your application: set all four, and refuse an unsigned answer
  or request. On a link that proved a key (`bound`, `wsh`), bind the signer to it with `requireLinkKey`.
- **There is no multi-hop delivery**: the ingress asks the one pod a mapping names over a link it has; a pod it has no
  direct link to is a 502 `provider-unreachable`. `retry` picks another named pod; it does not route.

## Defaults (each has a test)

| Rule | Default |
| --- | --- |
| Listener bind | `127.0.0.1` (`public: true` for anything else) |
| Methods | `GET`, `HEAD`; `methods` can add `POST PUT PATCH DELETE OPTIONS`; `CONNECT` and `TRACE` never |
| Request body | 64 KiB (`maxRequestBodyBytes`); over it is a 413; read in full before the provider is asked |
| Response | 8 MiB (`maxResponseBytes`); a declared length over it is refused before anything is sent |
| Whole request | 30 s (`timeoutMs`), 504 `provider-timeout` |
| Slow body / idle response | 10 s (`bodyIdleMs`, 408) / 15 s (`responseIdleMs`) between chunks |
| Headers / target | 64 headers, 16 KiB, 2048 characters |
| In flight | 64 total, 8 per client, 16 per provider (429 / 503, `Retry-After`) |
| Rate | 120 per client and 600 per provider, per minute |
| Request headers to the provider | `accept`, `accept-language`, `content-type`, conditional and `range` headers; `forwardHeaders` adds names. Never: hop-by-hop, `Host`, `Forwarded`, `X-Forwarded-*`, `Upgrade`, `Proxy-*`, `Expect`, `Content-Length` |
| Client address | the socket's; `trustProxy` (off) takes the entry the trusted proxy appended |
| Framing | `Transfer-Encoding` with `Content-Length`, a bad or repeated `Content-Length`, a body on GET/HEAD: 400 |
| Upgrade | 426: WebSocket is not bridged |
| Response headers | allow-list; `Set-Cookie`, `Content-Encoding`, HSTS, `Refresh`, CORS and unknown headers dropped |
| Forced | `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox` (a response is never framed; `contentSecurityPolicy` in the mapping replaces or removes it), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Vary` |
| Redirects | never followed; a `Location` that is not a path on this origin is a 502 |
| Audit | pod, host, method, status, reason, bytes, duration; never query strings, paths or bodies |

## CLI

```
browsermesh-ingress --listen 127.0.0.1:8080 --signaling wss://signal.example \
  --map app.example.test=<podId> [--map ...] [--allow-methods GET,HEAD,POST] [--max-body 64k] [--timeout 30s] \
  [--auth bearer:<file>] [--identity <file>] [--config file.json]
```

It joins the mesh as a pod (its identity is kept in `--identity`, created at mode 0600 on first run; the printed pod id
is what a provider names in `allowFrom` and grants `protocol:http:open`), prints what it serves and where it listens, and
exits non-zero with one sentence on bad input (2) or when the node cannot start (1). `--listen` must be loopback unless
`--public` is given together with `--tls-terminated-in-front` (a statement that TLS is terminated in front of it).
`--map HOST[/PREFIX]=PODID` (a prefix is stripped; two different pods under one hostname are refused). `--auth
bearer:FILE` requires `Authorization: Bearer <token in FILE>` on every request. `--config` takes the same options in JSON.
Without `node-datachannel` the CLI cannot reach any pod and says so; the library works over any transport you attach a
protocol service to.

## What is not built

- WebSocket upgrades (426). A later bridge would map each upgrade onto `mesh-websocket` frames over a second protocol,
  with the same pin, per-connection byte and idle limits and an explicit `Origin` policy.
- Routed (multi-hop) delivery: only direct links. Carrying `http` over routed messages would need `requireSealed` end to
  end and the verified originator of each sealed message compared with the mapped pod.
- Streaming the client's request body to the provider while the client is still sending (it is read first, bounded).
- TLS, caching, compression, per-root authorisation on the provider (`http:<root>:<action>`).

## Wire

Protocol `http` v1 on a protocol channel: one channel request `fetch { rid, nonce, method, target, host, headers, body,
client?, sig? } -> { status, headers, body, sig?, declined? }`; bodies are protocol streams (`{ rid, kind: 'request' }` ingress to
provider, `{ rid, kind: 'response' }` opened by the provider before it answers). No new framing; a peer without the
protocol answers the open with `unknown-protocol` and is sent nothing else. Design: [`docs/design/http-ingress.md`](../../docs/design/http-ingress.md);
threat model: [`docs/security.md`](../../docs/security.md#http-ingress).
