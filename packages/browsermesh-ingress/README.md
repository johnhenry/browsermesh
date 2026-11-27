# browsermesh-ingress

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-ingress.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-ingress)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-ingress.svg)](LICENSE)

Real HTTP in, a mesh pod answers. A request arrives at a listener you run; a mapping you wrote names ONE pod; that pod
(a browser tab, or a pod in Node or anywhere else that runs `serveHttpOnMesh`) answers it with a
`(Request) => Response` handler; the response goes back to the HTTP client.

It is a library (a web-standard `(Request) => Promise<Response>`, plus a Node listener on its own entry) and a CLI
(`browsermesh-ingress`).

## What changes on upgrade (0.8)

**Every method and a full, streamed request body are now on by default.** Before 0.8 a public address carried `GET` and `HEAD`
only (and an operator could opt in to `POST` and friends with a 64 KiB body, read whole). Now, when **both ends are new** (the
ingress, and the pod behind it, run this version):

- a visitor's `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` and any other method (an RFC 9110 token such as `PURGE` or `PROPFIND`)
  reaches the pod's handler, with its **whole body streamed** end to end (visitor, ingress, mesh channel, pod, the origin your
  handler fetches), with backpressure in both directions and nothing held whole. `CONNECT`, `TRACE` and `TRACK` are never carried;
- a pod that served `GET`/`HEAD`-only mappings **now accepts writing methods** (up to 32 MiB of body, both ends bounded, see
  Defaults) once the ingress in front of it is also on this version. **Whatever your origin accepts for a writing method is now
  reachable from the public address**, cookies and `Authorization` included when the operator forwards them (see "The security
  model").

**To keep `GET` and `HEAD` only**, narrow either end (both is fine; neither can widen the other):

```js
serveHttpOnMesh(service, handler, { allowFrom, methods: ['GET', 'HEAD'] })        // the pod: refuses the rest with 405 + Allow
createMeshIngress({ service, resolve, methods: ['GET', 'HEAD'] })                  // the ingress process
// CLI: browsermesh-ingress ... --allow-methods GET,HEAD
```

An older end is never sent what it cannot handle: an ingress in front of a pod that has not upgraded sends it `GET` and `HEAD` only
(a visitor's `POST` is a 405 with `Allow: GET, HEAD`), and a pod behind an ingress that has not upgraded is spoken to exactly as
before (see "Wire").

Peer dependency: `@johnhenry/browsermesh-apps` `>=0.21.0` (the protocol channel and its streams). The CLI also needs
`@johnhenry/browsermesh-core`, `-pod`, `-primitives`, `-transport` and `-discovery` (optional dependencies, installed by
default) and `node-datachannel` (an optional dependency) to reach pods over WebRTC from Node.

## Install

```bash
npm install @johnhenry/browsermesh-ingress @johnhenry/browsermesh-apps
```

Needs Node 26 or later. `@johnhenry/browsermesh-apps` is a peer dependency. The package also installs a `browsermesh-ingress` command (see [CLI](#cli)).

## What it is, and what it is not

- **It is** a bounded request forwarder: one mapping, one pod, protocol `http` (v2, or v1 with a pod that has not upgraded) on the
  existing protocol channel (`openProtocol(peer, 'http', { versions: [2, 1] })`), request and response bodies as protocol streams with
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

**Writing methods are on by default (0.8).** A public address now exposes **whatever the origin behind the pod accepts for
`POST`, `PUT`, `PATCH`, `DELETE` and every other method**, with the same trust as a `GET` had: cookies and `Authorization` are passed to
the pod exactly as they are for a `GET` today (only the names the operator lists in `forwardHeaders`; `Host`, `Forwarded` and
`X-Forwarded-*` are never passed, and the pod sees the ingress's own `X-Forwarded-For` when asked), the pod sees the verified ingress
pod id, and the response is filtered as ever. What a pod's handler does with a body it is sent is the pod owner's decision, and the
pod owner opts out per mapping with `methods`.

What a pod receives by default, and what that means for a write:

- **The request is not "as if served directly".** The pod gets the method, the target, the body, the allow-listed headers and the
  ingress's pod id. It does not get the visitor's `Host`, `Cookie` or `Authorization` (unless the operator forwards them), and it does
  not see the visitor's address (unless `forwardClientAddress`).
- **Cross-site writes.** A page on another site can make a visitor's browser send a write to a public address, and the browser adds the
  visitor's cookies for that address. Behind the ingress a pod can still tell: `Origin`, `Referer` and `Sec-Fetch-Site`, `Sec-Fetch-Mode`,
  `Sec-Fetch-Dest` and `Sec-Fetch-User` are forwarded by default (they are set by the visitor's browser and are not credentials). A pod that
  guards writes refuses one whose `Sec-Fetch-Site` is not `same-origin` (or `none`), or whose `Origin` is not its own address. **A client
  that is not a browser can set these headers to anything**: they defend a pod against other sites' pages, not against a client that
  talks to the address itself, which is what `authorize`, `deny` and the pod's own checks are for. Do the check in the pod's handler (or
  in the operator's `authorize` hook, which sees the same request); an origin that accepts writes needs its own cross-site protection.
- **Method override.** If you forward a header that makes an origin treat a request as another method (`X-HTTP-Method-Override` and its
  kin, through `forwardHeaders`), a visitor can reach a method the operator narrowed away: the ingress checks the method on the wire, not the one
  an origin reads from a header. Do not forward such headers to an origin behind a narrowed ingress.

An operator who wants today's behaviour on a public ingress sets `--allow-methods GET,HEAD` (or `methods: ['GET', 'HEAD']`).

### What the operator can see and change

Between the HTTP client and the pod there is an ingress process, and a TLS terminator in front of it. Whoever runs those is
**in the path**, by design: that is what makes it an ingress. Stated plainly, the operator:

- **can read** every request (method, path, query, headers, body) and every response the pod sends, because TLS ends in
  front of the listener and the mesh link to the pod carries what remains. The audit record the CLI prints does not hold
  paths, queries or bodies, but nothing stops the operator logging more;
- **can change** what either side sees: add or drop headers (`forwardHeaders`, `exposeHeaders`, `addHeaders`), answer instead of
  the pod, or send a request to another pod than the one the client meant;
- **can see** which pods exist, when they are linked (`stats()`, the audit lines, the names they claim) and how much they transfer;
- **cannot** make a pod do what its own handler and its own grants (`allowFrom`, `protocol:http:open`) do not allow, and cannot
  claim a pod's identity: the pod is addressed by its id on a link, and with `signRequest`/`verifyRequest` and `requireLinkKey` a
  pod can insist that a request was made by the ingress key it expects.

This is a property of the design, not something a setting removes: **there is no end-to-end confidentiality between the HTTP
client and the pod against the ingress operator.** Use an ingress you run yourself, or one whose operator you trust with the
traffic, exactly as you would a reverse proxy, a CDN or a hosting platform.

What is possible today for confidentiality from the operator: keep the secret at a layer the operator never holds. The
pod can sign what it serves (`sign`/`verifyResponse`, with the verifying key distributed another way), which stops an
operator changing a response unnoticed but does not hide it; and an application can encrypt its own payloads end to end
(for example with a key the browser and the pod share), which hides the payload but not the metadata above.

What would give the client TLS to the pod itself (the operator then sees only the server name and the byte counts) is
**TLS passthrough**: the ingress reads the SNI from the first bytes of a connection, maps it to a pod, and relays the raw
bytes both ways while the pod terminates TLS with its own certificate. That needs a raw byte stream to a pod, which
protocol `http` is not (it is request/response with a head, even with a streamed body). A
byte-stream protocol with the same pin, caps and grants as `http` is the missing piece; it is **not built**, and is listed under
"What is not built".

## Library

```js
import { attachService, createMeshProtocolService } from '@johnhenry/browsermesh-apps'
import { createMeshIngress } from '@johnhenry/browsermesh-ingress'
import { listenNode } from '@johnhenry/browsermesh-ingress/node'

const service = attachService(node, undefined, createMeshProtocolService())
const ingress = createMeshIngress({
  service,                                                   // or `node`, to have one attached
  resolve: (request) => new URL(request.url).host === 'app.example.test' ? { peer: appPodId } : null,
  methods: ['GET', 'HEAD', 'POST'],                          // every method by default; a list NARROWS it
  onAudit: (record) => console.log(record),                  // { peer, host, method, status, reason?, requestBytes, responseBytes, durationMs }
})
const { port, close } = await listenNode(ingress, { port: 8080, host: '127.0.0.1', trustProxy: false })

// anywhere else: a Workers or Deno handler is just
//   export default { fetch: (request) => ingress.handle(request, { clientAddress }) }
```

`createMeshIngress({ node | service, resolve, names?, authorize?, deny?, limits?, methods?, versions?, forwardHeaders?, exposeHeaders?,
forwardClientAddress?, verifyResponse?, signRequest?, linkIdentity?, retry?, rpc?, onAudit?, clock? })` returns
`{ handle(request, { clientAddress }), expect(podId), readiness(), whenReady(), stats(), close() }`. `resolve` may be left out
when `names` is given.

`listenNode(ingress, { halfClosedClients: true })` serves a client that has sent its whole request and then finished sending
(`nc -N`, `shutdown(SHUT_WR)`): the connection stays open for the answer, however long the provider takes within
`limits.timeoutMs`, and ends after the response. Off by default: Node's HTTP server ends such a connection at the client's end
of file, which loses the answer, but a client's end of file is also all that Firefox and WebKit send when a fetch is aborted, and
with the option on that no longer aborts the page's handler until `limits.timeoutMs`. A request that is not complete
when the client finishes is not served and is ended, as before; a client that finishes sending and never reads is bounded by
`limits.timeoutMs`, not held.

- `resolve(request, { attempt, tried }) -> Promise<{ peer, service?, path?, headers?, response? } | null>`: `peer` is the pod id the
  answer is pinned to; `service` names the service on that pod (see "Several services on one pod"); `path` replaces the request's path (the query is kept); `headers` are added to what the provider
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

### Methods and request bodies

With both ends new, every request carries its method and its whole body to the pod's handler, streamed.

- **Methods.** Any RFC 9110 method token (`PURGE`, `PROPFIND`, `M-SEARCH`, a name of your own), case-sensitive as sent (the standard
  ones are upper case). `CONNECT`, `TRACE` and `TRACK` are always refused (405 with `Allow`, whatever the options say), and so is
  anything that is not a token. **`OPTIONS`, a CORS preflight included, is passed to the pod like any other method**; the ingress
  answers nothing itself, so the pod (or the operator's `response.addHeaders` / `exposeHeaders`) decides what a preflight gets. The
  Node listener can only parse the methods Node's HTTP parser knows (`http.METHODS`: the standard ones, WebDAV, `PURGE`, `M-SEARCH`,
  `SUBSCRIBE` and about thirty more); a token outside that list is answered `501 Not Implemented` by the listener. The web-standard
  `handle(request)` carries any token (a Workers or Deno handler, or your own listener).
- **The body** is read from the visitor only as fast as the pod takes it: `Content-Length` and chunked both, no read-ahead beyond one
  stream window (256 KiB) per request, so a slow origin slows the visitor through TCP, and a slow visitor slows the origin. The pod's
  handler gets an ordinary `Request` whose `body` is that stream (and `Content-Length`, when the visitor declared one), so
  `fetch(origin, { method: request.method, body: request.body, duplex: 'half', signal })` passes it on without holding it. A runtime that
  cannot build a `Request` from a stream (some browsers) is given the same bytes whole, bounded by `maxBodyBytes`.
- **Request trailers are dropped**: a web `Request` has none, and neither end passes them (`Trailer` and `TE` headers are never forwarded).
- **`Expect: 100-continue`** is answered by the listener (not by Node's default, which says "continue" at once): `100 Continue` is sent
  when the ingress is ready to read the first byte, that is after the method, the mapping, the limits and the provider's own
  `capabilities` have said yes. A client that is going to be refused (405, 413, 404, 403...) gets its final status and no `100`, and
  sends no body. A client that does not wait sends the body anyway, which is bounded like any other.
- **An answer before the upload ends** (a handler that returns 401 or 413 without reading the body) is delivered, and the upload
  is stopped: the pod cancels the stream, the ingress stops reading the visitor, the response says `Connection: close`, and the
  listener reads and discards at most 1 MiB or 2 s of what the client still sends before it hangs up (so a client that is still
  sending can read the answer). A handler that is reading the body while it answers (an echo) keeps the upload going until the answer
  is over.
- **A visitor that disconnects mid-upload** ends the request as `client-aborted` (499 in the audit record): the pod's `request.body`
  errors (`stream-aborted`), the handler's `signal` aborts, and so does the origin `fetch` it passes that signal to.
- **Limits that break during an upload** are the answer: the ingress's or the pod's byte cap is a 413 `body-too-large` (a declared
  length over it is refused before a byte is read, a chunked body is cut at the cap), a stalled visitor is a 408 `body-timeout`, the
  whole request running past `uploadTimeoutMs` is a 504 `provider-timeout`, and a body that is not the length `Content-Length`
  declared is a 400 `bad-framing`.
- **What is held whole.** A body is held in memory (up to `maxBufferedBodyBytes`, 1 MiB; over that is a 413) only where something needs all
  of it: a pod that has not upgraded, a request you sign with `signRequest` (the signature covers the body's digest, so the pod also
  holds it when it has a `verifyRequest`), a request `retry` may repeat (a body of declared length up to 1 MiB, or unknown length that
  ends within 1 MiB; a larger one streams and is never retried), and the `rpc` fallback. **A pod in a runtime that cannot build a
  `Request` from a stream (some browsers, which would otherwise turn the stream into text) holds the body whole too**: up to
  `limits.maxHeldBodyBytes` (8 MiB; 1 MiB would refuse ordinary uploads, and the full 32 MiB would hold about twice that in memory) and on
  at most 2 uploads at a time per link. It says so in `capabilities` (a smaller `maxBodyBytes` and `maxUploads`), so the ingress refuses an
  over-size body with a 413 before it sends it.
- **Tiny chunks cost bytes, not objects.** The ingress joins what it reads (to one 64 KiB block for a body it holds, to about 16 KiB, for at
  most 5 ms, for a frame it sends), so a client that writes one byte at a time makes a few frames, and a held body is a few blocks.
- **A trickle is cut.** One address cannot keep an upload slot by sending a byte now and then. After a grace of 30 s
  (`uploadGraceMs`), in every 10 s window (`uploadProgressMs`) in which the ingress was waiting for the client, at least 1 KiB per second
  (`uploadMinBytesPerSec`) must arrive, or the request ends with a 408 `body-timeout`. The pod applies the same rule to what arrives on the
  link (a slow origin is never blamed on the sender). One address also has at most 2 uploads in flight (`maxUploadsPerClient`; the next is
  a 429 `client-uploads`) of the 4 a pod's link takes. **What stays possible:** a client at 1 KiB/s for the whole 5 minutes still holds
  its 2 slots; many addresses can still fill a pod's 4 slots (that is what `authorize`, `deny` and `--max-uploads` are for).

### The provider

```js
import { serveHttpOnMesh, fromSiteHandler } from '@johnhenry/browsermesh-ingress'

const served = serveHttpOnMesh(service, async (request, { peer, signal, client }) => new Response('hello'), {
  allowFrom: [ingressPodId],           // required: nothing is served to a pod that is not named
  methods: ['GET', 'HEAD', 'POST'],    // optional: every method by default; a list NARROWS it ('*' says every one)
  maxBodyBytes: 8 * 1024 * 1024,       // optional: 32 MiB by default; Infinity only by choice
  limits: { maxInflight: 16, maxUploads: 4, maxRequestBodyBytes: 1024 * 1024, maxResponseBytes: 8 * 1024 * 1024, handlerTimeoutMs: 30_000, uploadTimeoutMs: 300_000, bodyIdleMs: 10_000 },
})
node.registry.grantCapabilities(ingressPodId, ['protocol:http:open'])   // the registry grant is required too
// await served.stop(); served.stats()
```

`await served.stop()` stops taking links and closes the `http` channels, and resolves once the notices that they closed have
left this pod: that is how the ingress learns, at once, that the requests it was waiting on are over (a visitor of a request
in flight is answered 502 `provider-closed`, not left to the request deadline). Do not close the node before it resolves: a
close notice that has not left is lost with the link. `stop({ graceMs })` (default `0`: end everything now) first lets the
requests being answered finish, for at most `graceMs` milliseconds; a request that arrives meanwhile is refused and the visitor
is told 503 `provider-stopping` (with `Retry-After`); what is still being answered when the grace runs out is ended as above.
With `@johnhenry/browsermesh-apps` 0.28 or older on the pod the close notice is still sent but `stop()` has nothing to wait for
(a channel's `close()` gave no promise), so it resolves at once and the notice can still be lost to a node closed straight after.

`handler` is a function or `{ fetch }`. `peer` is the ingress pod, the pod id the channel is addressed by (never a header);
whether that id was proven on the link is a separate question, answered by the `peer` object the hooks get (next
section). `signal` aborts when the client goes away or the deadline passes. `request.url` is `http://<the client's host><path>`.
The request body is a stream the handler reads (see "Methods and request bodies"); the response body streams too. **`methods` and
`maxBodyBytes` are the pod's own word**: the ingress cannot widen them, and a request the pod would refuse (405 with `Allow`, or 413) is
refused before a byte of its body is read, whatever the ingress was told. They can differ per service:
`services: { api: { fetch: handler, methods: ['GET', 'POST'], maxBodyBytes: 1_000_000 }, web: { fetch: handler, methods: ['GET', 'HEAD'] } }`
(a service that names none inherits the pod-wide setting). A pod that has not upgraded (protocol version 1) treats an explicit
`methods` the same way; with none given it serves what a v1 ingress sends, as it always did.

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

## Several services on one pod

A pod can serve more than one thing (a site and an API, two local ports) and say which, by name. The pod declares them; the
route names one; the ingress asks for nothing the pod did not declare.

```js
serveHttpOnMesh(service, null, {                       // null: no default handler; or pass one as before
  allowFrom: [ingressPodId],
  services: { web: (request, ctx) => proxyTo(8080, request), api: { fetch: (request) => proxyTo(8081, request) } },
})
createMeshIngress({ service, resolve: (request) => ({ peer: podId, service: 'api', path: '/v1' }) })
// CLI: --map=site.example.test/web=<podId>#web --map=site.example.test/api=<podId>#api --map=db.example.test=<podId>#db
```

A handler that serves several services finds the name in `ctx.service` (the second argument, next to `peer`, `signal` and
`client`; it is absent for a route with no service). A site handler wrapped with `fromSiteHandler` is given it as the `service`
field of the request object it receives. The ingress's own record of each request (`onAudit`, and the line the CLI prints) names
the service as well as the host: `service` on the record when the route has one, and `GET site.example.test -> <podId>#web 200 ...`
on the CLI line (a route with no service prints, and records, exactly what it always did). A route with no service reaches the pod's default
handler; a pod declared with `handler: null` and no default refuses it. A service name is `[a-z0-9][a-z0-9._-]{0,63}`; a pod
declares at most 32. One pod behind several hostnames or paths is the same trust domain, so it does not need
`--allow-shared-origin` (two different pods under one hostname still do).

- **Wire (additive).** The `fetch` head may carry `service`, and a pod that declares services answers one more channel
  request, `services {} -> { services: string[], default: boolean }` (the ingress asks once per link, and only for a route that
  names a service). A request signature (`signRequest`/`verifyRequest`) covers `service` when there is one and is byte for byte
  what it was when there is none.
- **An older pod** knows neither: asked `services`, it answers "unknown method", which the ingress reads as "no named services",
  so a route that names a service is a 502 `provider-no-service` and nothing is sent. A route that names none works as before.
  **An older ingress** never sends `service` or asks `services`; a pod that declares services serves its default to it (or
  refuses, when it has none).

## Names a pod may claim (off by default)

An operator can let pods choose their own names under a zone the operator owns (`app.pods.example.test`), instead of mapping
hostnames to pod ids by hand. Nothing here runs unless the operator builds a name table and serves it.

```js
import { createNameTable, serveIngressNames, registryAllow, createMeshIngress, openNameClient } from '@johnhenry/browsermesh-ingress'

// ingress side
const names = createNameTable({ zone: 'pods.example.test', allow: registryAllow(node.registry), holdMs: 30_000 })
serveIngressNames(service, names)                       // protocol `ingress-names` v1 on the protocol channel
node.registry.grantCapabilities(podId, ['protocol:ingress-names:open', 'ingress:name:app:claim'])
const ingress = createMeshIngress({ service, names })   // mappings of your own (`resolve`) are asked first, claimed names after

// pod side: the channel is the claim's lifetime
const client = await openNameClient(service, ingressPodId)
await client.claim('app', { service: 'web' })           // -> { name: 'app', host: 'app.pods.example.test', service: 'web' }
```

The rules, each with a test:

- **A grant per name, written by the operator.** The pod needs `protocol:ingress-names:open` (the protocol channel's own default
  deny) and then the registry scope `ingress:name:<label>:claim` for that label (`ingress:name:*:claim` for any). `registryAllow`
  reads exactly that; `allow` may be any function. Without `allow` nothing is claimable. The pod is the channel's verified peer, never
  a field of the message. A grant revoked stops the next claim.
- **Never a name another live pod holds**, and two claims racing for one name give it to one. A pod that holds a name and claims it
  again is changing its service, not taking a second slot.
- **Held while the link is up, released a short while after it drops.** When the claiming channel is lost (the link drops, or the
  channel closes with no goodbye) the name is held for `holdMs` (default 30 s; 0 frees it at once) for that pod only: a
  stranger cannot take it in between, the same pod gets it back at once by claiming on its new channel, and a channel that closes
  late (after the pod came back) takes nothing from the new claim. After the hold the name is free for anyone with a grant. A
  request for a held name waits for its pod (see below).
- **A goodbye gives the names up at once.** `await client.close()` says goodbye (a `bye` request, then the channel closes with
  the reason `done`): what that channel claimed is released, not held, so nobody waits for a pod that is not coming back and a
  request for the name is a 404 straight away. Only a close with a goodbye does this; a lost link is still held.
- **Bounded**: `maxPerPod` (4), `maxNames` for the zone (64; held names count), and `claimRate` (30 attempts per pod per
  minute, refused ones included). A pod flapping its link re-claims within the same allowance.
- **Names are plain DNS labels**: lowercase letters, digits and hyphens, 1 to 63 characters, no hyphen at either end, no case
  folding, **no hyphens in the third and fourth places** (which refuses punycode `xn--` labels and what is built to look like
  them), and a **deny-list** of labels that read as something an operator owns (`www`, `api`, `admin`, `mail`, `login`, `auth`,
  `ns1`, `localhost`, and more: `NAME_DENY_DEFAULTS`). The operator adds to it with `deny` (a trailing `*` is a prefix). A denied
  label is refused even when a grant names it: map those by hand. A host the operator maps by hand (`reserved`) is not claimable.
- **Audit**: `onAudit` gets `{ type: 'name', action: 'claim'|'refuse'|'release'|'hold'|'expire', pod, name, reason? }`; the CLI
  prints them.

<!-- names-table:begin -->
| Reason | Refused because |
| --- | --- |
| `bad-name` | the label is not a plain lowercase DNS label (or has hyphens in the third and fourth places) |
| `bad-service` | the service is not a short plain name |
| `claim-rate` | too many claims from this pod in the window (the refusal carries `retryAfterMs`) |
| `denied-name` | the label is on the deny-list |
| `name-reserved` | the host is mapped by the operator |
| `name-taken` | another pod holds the name (live, or in its hold) |
| `not-granted` | the pod holds no grant for that name |
| `too-many-names` | the pod holds its limit |
| `zone-full` | the zone holds its limit |
<!-- names-table:end -->

CLI: `--names-zone pods.example.test --names-allow=<podId>=app,blog [--names-allow=...] [--names-deny staff,ops-*] [--names-max N]
[--names-max-per-pod N] [--names-hold 30s]`; the grants are written into the node's registry, and every `--names-*` flag without
`--names-zone` is refused.

- **Wire (additive).** A new protocol, `ingress-names` v1, on the protocol channel, served only when the operator serves it:
  `claim { name, service? } -> { name, host, service? }`, `release { name } -> { released }`, `names {} -> [{ name, host,
  service?, held }]`, and (0.6) `bye {} -> { released: string[] }`; a refusal is a channel error whose `reason` is one of the
  table above.
- **An older ingress** does not serve the protocol: the pod's `openNameClient` fails (unknown protocol) and nothing else changes.
  An older ingress that serves it does not know `bye`: the client's close ignores that answer and closes the channel with the
  reason `done` all the same, which that ingress treats as any lost channel, so the names are held for `holdMs` as they always were.
  **An older pod** never opens it, or closes its channel with no `bye`: a new ingress reads the reason `done` of an older client's
  `close()` as the goodbye it was meant as (names released); any other close is a lost link (names held). The `http` protocol
  does not change, so a claimed name is served over `http` as any mapping is (with the pod's `methods` and `maxBodyBytes`).

### Closing a pod: the order

Say goodbye first, take the services down, close the node last, and wait for each step:

```js
await client.close()      // the names are given up and the ingress has heard it (it answers `bye`); at most `closeTimeoutMs`, 2 s
await served.stop()       // the `http` channels close, and their close notices have left (add { graceMs } to let requests finish first)
await node.shutdown()     // then the node
node.meshManager.closeAll()   // and its connections, if the page is going to keep running
```

The goodbye goes first so that no visitor is sent to a pod that is leaving (the name is gone at once: a 404), and the services
next, so that the requests still being answered end (or finish, within `graceMs`) with a status. **`served.stop()` must be
waited for.** It used to return before the close notices had left, and the node's close that followed cut them off: the
ingress was never told, and a request in flight waited for its whole deadline (`timeoutMs`, 30 s) before a 504 `provider-timeout`.
Closing the node first (or not waiting for `client.close()`) can likewise cut the goodbye off before it leaves, and the ingress then
learns the pod is gone only from the link ending, so the names are held for `holdMs` and a request for one waits for a pod that
is not coming back. Closing a names client does not touch the `http` channels or the link: only the names it claimed go.
If the link ends without any of this (a tab closed, a network lost), the ingress still sees it end: a node whose connection
closes ends its link at once (apps 0.28), where it used to be noticed only by the next request or timeout.
- **Not built, on purpose**: names for a pod that has no link to the ingress (a claim needs the channel, so the pod has dialled
  or been dialled), per-name TLS certificates (TLS is in front of the listener, as always), and DNS (the operator points a
  wildcard record at the listener; the ingress does not publish names).

## The first request, and readiness

A pod the ingress was told to expect (`ingress.expect(podId)`; the CLI does it for every mapped pod) is dialled at start and
kept dialled, and **a request that arrives before the link is up waits for it** instead of failing: up to `limits.linkWaitMs`
(5 s; `--link-wait`), never past the request's own deadline, and then with the original failure. The same wait covers a link that
dropped (it is dialled again), and a request for a name in its hold (the pod is expected for the length of the hold). A pod nobody
expects behaves exactly as before: the first failed open is the answer.

`ingress.readiness()` is `{ ready, peers: { up, total } }` (ready when every pod expected for good has a live link; it never names
a pod), and `await ingress.whenReady({ timeoutMs })` waits for it. `listenNode(ingress, { readyPath: '/_ready' })` (CLI:
`--ready-path /_ready`) answers `GET` and `HEAD` for exactly that path with 200 or 503 and that JSON. It is off unless asked for, it is
answered before any request reaches a pod, and it shadows that one path for every hostname, so pick a path no pod serves.

**Who dials.** The CLI's node dials the pods it serves (WebRTC through the signaling server, `connectToPeer`) and also accepts a
pod that dials it, so either side can start the link; a pod that cannot accept inbound connections dials the ingress's pod id
(printed at start) and the ingress uses that link. Nothing about this is new; what is new is that the dialling now starts when the
ingress starts rather than at the first request.

**Both sides dialling at once.** With a hand mapping and the CLI's default dialling the ingress is dialling the pod while the pod
dials the ingress. The two connection attempts used to cross and cancel each other (each side answered the other's offer and
dropped its own, so neither dial was answered), and the first requests failed until the dials timed out. Now one of them wins:
**the lower pod id's offer wins**, the other side drops its own offer, answers it and takes the connection, and both dials come
back with that one connection in a second or two. A request that arrives meanwhile waits for the link (up to `--link-wait`) as for
any link still being made. This is decided in `@johnhenry/browsermesh-apps` (the WebRTC negotiator), so it holds for every pair of
peers that dial each other, not only for the ingress. `--link-wait 0` still turns the ingress's dialling off, if you would rather
the pod alone dials.

**A pod that stops and starts again** (the same identity, a new page or a new process) against an ingress that keeps running is
served at once: its first answer is whole and the second link is not touched by the end of the first. What was wrong: a
connection the pod's node had closed without closing the WebRTC connection under it stayed on the ingress, and the new start
reused it, so the node wired the one connection in twice and delivered every message twice; the second copy of the end of a
response read as a stream error, and the ingress cut the visitor off after the whole body (`provider-failed`) and then dropped the
link. Now one connection is one session, a link ends when its connection ends, and a frame left over from a link that has ended
cannot touch the one that replaced it.

**A pod that only serves** (a hand `--map`, no name claimed: the pod never opens a channel to the ingress) and restarts on the
connection the ingress still holds open was not noticed: the ingress went on sending over a link the new node knows nothing of,
and the visitor waited out `openTimeoutMs` (10 s) for a 504 `provider-timeout`, on every request, for as long as the ingress kept
that link (a pod that claims a name opens a channel and says hello, which is why a claimed name did not have this). Now an offer that
arrives for a connection the node holds open ends the channel link that ran over it (in `@johnhenry/browsermesh-apps`, on the ingress's side), so the
requests on it end at once with 502 `provider-closed` and the next one opens a new link on the pod's new connection. Nothing else
is needed from the pod: serve, dial, and (for a pod that stops) `await served.stop()` as above. The change is on the ingress's
side and adds nothing to the wire: an older pod is served as well as a new one, and an older ingress is as it was (the stale link
stays until something ends it).

**The first request after a restart is answered, not cut.** A visitor's request can arrive in the moment between the pod's new
connection being answered and the ingress being told the pod started over (or a send on the swapped connection fails, which
ends the link). The request was then on the old link and ended as a 502 `provider-closed` within a few milliseconds. Now, once,
without `retry` and without asking `resolve`, the ingress sends it again on the new link when it had no answer byte and either
(a) the pod started over on the connection (what the old link carried was never seen by the new life) and the method is
`GET`, `HEAD`, `OPTIONS`, `PUT` or `DELETE`, or (b) it never left (the transport under the link refused its first frame, or ended before it was taken) and the method is one of those,
or any other method with no body at all. Never when the answer had begun, never when the body is streaming (it was read from the
visitor and cannot be read again), never a `POST` or `PATCH` that has a body, and `retry.nonIdempotent` does not widen it. The
audit sink sees the attempt that was sent again as one more record with `retried: true` and `reason: 'provider-closed'`
(`stats().retries` counts it). An older pod is not told anything: it is sent the same request it would have been sent.

**What an older peer does.** Both fixes are in `@johnhenry/browsermesh-apps` (0.28), which the ingress and the pod each run.
- *A pod older than the fix, an ingress with it*: restarts are served (the duplicate connection was the ingress's), and a crossing
  dial is won by the ingress (an older pod's offers carry no marker, so it is assumed to give way, as every older pod does): the
  pod's own `connectToPeer` may report an answer timeout after the link is already up, and the link is. The pod needs nothing.
- *An ingress older than the fix, a pod with it*: nothing is fixed. The ingress still wires a restarted pod in twice, and a dial
  that crosses the pod's still fails until it times out; upgrade the ingress (`--link-wait 0` is the workaround for crossing dials).
- Two peers with the fix agree on the lower pod id; a peer that sends the marker is never answered with an older behaviour.
  The wire additions are a `glare` field on a WebRTC offer and the link's id (`sid`) on every channel frame; a peer that predates
  them ignores both, and a frame without an id is accepted exactly as before.

## Headers, by default and on purpose

What crosses, with no option set (a test pins both lists to the code):

<!-- headers-table:begin -->
| Direction | Passed by default | Never, whatever you set |
| --- | --- | --- |
| Request, client to provider | `accept`, `accept-language`, `content-type`, `if-match`, `if-modified-since`, `if-none-match`, `if-unmodified-since`, `range`, `origin`, `referer`, `sec-fetch-site`, `sec-fetch-mode`, `sec-fetch-dest`, `sec-fetch-user` | `host`, `connection`, `keep-alive`, `proxy-*`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `content-length`, `expect`, `forwarded`, `x-real-ip`, `via`, `x-forwarded-*`, `x-original-url`, `x-rewrite-url` |
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
| 405 | `method-not-allowed` | a method this ingress or this pod does not carry: `CONNECT`, `TRACE`, `TRACK`, a non-token, one outside `methods` on either end, or anything but `GET` and `HEAD` for a pod that has not upgraded (with `Allow`) |
| 408 | `body-timeout` | the client's body stalled (either end's idle bound) |
| 413 | `body-too-large` | the request body is over the cap of this ingress or of the pod: refused unread when its length was declared, cut at the cap when it was not |
| 414 | `target-too-long` | the target is over 2048 characters |
| 426 | `upgrade-unsupported` | a WebSocket or other upgrade |
| 429 | `client-inflight` | too many requests from this client in flight (with `Retry-After`) |
| 429 | `client-uploads` | this client already has as many requests with a body in flight as one address may (with `Retry-After`) |
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
| 502 | `provider-no-service` | the route names a service the provider did not declare (or serves none by name) |
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
| 503 | `provider-stopping` | the provider is being stopped (`served.stop()`) and takes no new request (with `Retry-After`) |
| 503 | `provider-uploads` | this pod's link is carrying as many requests with a body as the ingress or the pod allows (with `Retry-After`) |
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
| Methods | every method token, at the ingress (`methods`, `--allow-methods`) and at the pod (`serveHttpOnMesh`'s `methods`); a list narrows it; `CONNECT`, `TRACE` and `TRACK` never. A pod that has not upgraded: `GET` and `HEAD` |
| Request body | streamed, never held whole; **32 MiB** at the ingress (`maxRequestBodyBytes`, `--max-body`) and **32 MiB** at the pod (`maxBodyBytes`); over it is a 413 (refused unread when the length was declared, cut at the cap when it was not); `Infinity` / `--max-body unlimited` only by choice |
| Body held whole | 1 MiB (`maxBufferedBodyBytes`; a pod that has not upgraded, a signed request, a request `retry` may repeat); over it is a 413 |
| Whole request with a body | 5 min (`uploadTimeoutMs`, `--upload-timeout`) at the ingress, `max(handlerTimeoutMs, uploadTimeoutMs)` = 5 min at the pod; 504 `provider-timeout` |
| Uploads in flight | 4 requests with a body per pod link at the ingress (`maxUploadsPerProvider`, `--max-uploads`) and 4 at the pod (`limits.maxUploads`; 2 where the pod holds bodies whole); the next is a 503 `provider-uploads` with `Retry-After`. 2 per client address (`maxUploadsPerClient`): the next is a 429 `client-uploads` |
| Upload progress | after 30 s (`uploadGraceMs`), 1 KiB/s (`uploadMinBytesPerSec`) in each 10 s window (`uploadProgressMs`) spent waiting on the sender, at both ends; under it, 408 `body-timeout` |
| Held body at a pod that cannot stream | 8 MiB (`limits.maxHeldBodyBytes`), 2 uploads at a time |
| Bytes per second | no bound: the response has none either (the bounds are bytes, time, concurrency and one 256 KiB stream window); the Node listener's `requestTimeoutMs` is 300 s |
| Response | 8 MiB (`maxResponseBytes`); a declared length over it is refused before anything is sent |
| Whole request | 30 s (`timeoutMs`), 504 `provider-timeout` |
| Link wait | 5 s (`linkWaitMs`), only for a pod told to be expected (`expect`, the CLI's mapped pods, a held name); any other pod fails at once |
| Names, readiness | off: nothing is claimable and no readiness path is answered until the operator turns them on |
| Slow body / idle response | 10 s (`bodyIdleMs`, 408; the same bound at the pod, waiting on the link and never on the handler) / 15 s (`responseIdleMs`) between chunks |
| Headers / target | 64 headers, 16 KiB, 2048 characters |
| In flight | 64 total, 8 per client, 16 per provider (429 / 503, `Retry-After`) |
| Rate | 120 per client and 600 per provider, per minute |
| Request headers to the provider | `accept`, `accept-language`, `content-type`, conditional and `range` headers, and the browser-set `origin`, `referer` and `sec-fetch-*` headers; `forwardHeaders` adds names (never cookies or `authorization` unless named). Never: hop-by-hop, `Host`, `Forwarded`, `X-Forwarded-*`, `Upgrade`, `Proxy-*`, `Expect`, `Content-Length` |
| Client address | the socket's; `trustProxy` (off) takes the entry the trusted proxy appended |
| Framing | `Transfer-Encoding` with `Content-Length`, a bad or repeated `Content-Length`, a body on GET/HEAD: 400 |
| Upgrade | 426: WebSocket is not bridged |
| Response headers | allow-list; `Set-Cookie`, `Content-Encoding`, HSTS, `Refresh`, CORS and unknown headers dropped |
| Forced | `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox` (a response is never framed; `contentSecurityPolicy` in the mapping replaces or removes it), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Vary` |
| Redirects | never followed; a `Location` that is not a path on this origin is a 502 |
| Audit | pod, service (when the route names one), host, method, status, reason, bytes, duration; never query strings, paths or bodies |

## CLI

```
browsermesh-ingress --listen 127.0.0.1:8080 --signaling wss://signal.example \
  --map=app.example.test=<podId> [--map=...] [--allow-methods GET,HEAD,POST] [--max-body 8m] [--max-uploads 4] \
  [--timeout 30s] [--upload-timeout 5m] \
  [--auth bearer:<file>] [--identity <file>] [--config file.json] \
  [--link-wait 5s] [--ready-path /_ready] \
  [--names-zone pods.example.test --names-allow=<podId>=app,blog ...]
```

It joins the mesh as a pod (its identity is kept in `--identity`, created at mode 0600 on first run; the printed pod id
is what a provider names in `allowFrom` and grants `protocol:http:open`), prints what it serves and where it listens, and
exits non-zero with one sentence on bad input (2) or when the node cannot start (1). `--listen` must be loopback unless
`--public` is given together with `--tls-terminated-in-front` (a statement that TLS is terminated in front of it).
`--map HOST[/PREFIX]=PODID[#SERVICE]` (a prefix is stripped; `#SERVICE` names the service on that pod, see above; two different pods
under one hostname are refused). The mapped pods are dialled at start (`--link-wait 0` turns that and the wait off). `--auth
bearer:FILE` requires `Authorization: Bearer <token in FILE>` on every request. `--config` takes the same options in JSON.
**Option values.** `--option=value` is the form that is safe for any value: everything after the first `=` is the value. Write
every option that takes an id (`--map`, `--names-allow`) that way, because a pod id is base64url text and about one in four
thousand begins with `-` or `--`. The separate form `--option value` takes the next argument as the value whatever it starts
with (so those ids work there too); the value counts as missing only at the end of the arguments, or when the next argument
is itself a known option (`--known`, `--known=...`, `-h`), e.g. `--map --listen 127.0.0.1:80` is "needs a value".
Without `node-datachannel` the CLI cannot reach any pod and says so; the library works over any transport you attach a
protocol service to.

**Narrowing from the command line** (every method and 32 MiB bodies are the default, so these only take away): `--allow-methods
GET,HEAD` (a comma separated list of method names; `*` says every one), `--max-body 64k` (or `unlimited`), `--max-uploads 1`,
`--upload-timeout 1m`. They are config keys too (`allowMethods`, `maxBody`, `maxUploads`, `uploadTimeout`). The start-up line says
what is on (`methods: every method (not CONNECT, TRACE or TRACK); body cap 33554432 bytes`).

## What is not built

- WebSocket upgrades (426). A later bridge would map each upgrade onto `mesh-websocket` frames over a second protocol,
  with the same pin, per-connection byte and idle limits and an explicit `Origin` policy.
- Routed (multi-hop) delivery: only direct links. Carrying `http` over routed messages would need `requireSealed` end to
  end and the verified originator of each sealed message compared with the mapped pod.
- TLS passthrough (the pod terminates TLS itself and the operator relays bytes it cannot read): needs a byte-stream protocol to a
  pod, selected by SNI, with the same pin, caps and grants as `http`. See "What the operator can see and change".
- A method token the Node HTTP parser does not know through the Node listener (501): the listener rides `node:http`, which parses
  `http.METHODS` only. `handle(request)` has no such limit; a listener of your own can carry any token.
- HTTP/2 and HTTP/3 listeners, and request trailers (dropped).
- A bytes-per-second bound per link (there is none for responses either; the bounds are bytes, time and concurrency).
- TLS, caching, compression, per-root authorisation on the provider (`http:<root>:<action>`).

## Wire

Protocol `http` on a protocol channel: one channel request `fetch { rid, nonce, method, target, host, headers, body,
client?, sig? } -> { status, headers, body, sig?, declined? }`; bodies are protocol streams (`{ rid, kind: 'request' }` ingress to
provider, `{ rid, kind: 'response' }` opened by the provider before it answers). Additions since v1's first release, all optional: `service` in
the head and the `services` request (above), and the separate `ingress-names` protocol. No new framing; a peer without the
protocol answers the open with `unknown-protocol` and is sent nothing else.

**Version 2 (0.8): any method, a streamed body.** Negotiated by the protocol's own version list: the ingress opens the channel
offering `[2, 1]`, a pod serves `[1, 2]`, and the channel runs at the highest both have. What version 2 adds, and nothing else:

- the `fetch` head's `method` may be any method token (version 1 knows the seven standard ones), and the head may carry `length` (the
  `Content-Length` the visitor declared, when it did; the pod refuses a length over its cap before reading, and checks the body
  against it);
- the request body is read by the pod as the handler asks for it (version 1 reads it whole before the handler runs);
- a new channel request, answered only on a version 2 channel, **`capabilities {} -> { default: { methods, maxBodyBytes } | null,
  services: { [name]: { methods, maxBodyBytes } }, maxUploads }`** (`methods` is `"*"` or a list; `maxBodyBytes` is a number or `null`
  for none). That is how a pod states what it accepts, per service. The ingress asks once per link, and only when a request needs it (a
  body, or a method other than `GET` and `HEAD`); a plain `GET` asks nothing, so a pod that narrows `GET` refuses it itself;
- channel errors the ingress understands: `method-not-allowed` (405), `body-too-large` (413), `body-timeout` (408), `bad-framing`
  (400) and `uploads-busy` (503 `provider-uploads`).

**What each pairing does** (each is tested; "older" is simulated by not stating version 2):

| Ingress | Pod | What happens |
| --- | --- | --- |
| new | new | version 2: every method, bodies streamed, `capabilities` asked once per link |
| new | older | version 1: the ingress sends `GET` and `HEAD` only and never a `capabilities` request, a head field or a body stream the pod does not know; a visitor's `POST` is a 405 with `Allow: GET, HEAD`. (An operator's own explicit `methods` list keeps working for the standard methods in it, the body held whole up to 1 MiB, exactly as `methods: [...]` always did.) |
| older | new | version 1 (the older ingress offers only 1): the pod says nothing new on the wire, answers what the older ingress sends as before, and keeps any `methods` narrowing it was given |
| older | older | as before |

A pod that negotiated version 2 but does not answer `capabilities` is treated exactly as a pod on version 1 (GET and HEAD, or the
standard methods in an operator's own list, bodies held whole): the ingress never sends a method or a body stream it was not told is taken.

A signed request (`signRequest`) is sent held whole on any version, because the signature covers the body's digest; the pod's
`verifyRequest` holds it too. Design: [`docs/design/http-ingress.md`](../../docs/design/http-ingress.md);
threat model: [`docs/security.md`](../../docs/security.md#http-ingress).

## License

MIT
