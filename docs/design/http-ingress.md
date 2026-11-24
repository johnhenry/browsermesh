# HTTP ingress: real HTTP in, a mesh peer answers

Package: `@johnhenry/browsermesh-ingress` (new, 0.1.0). Decided 2026-11-24.

## What it is

A request forwarder. An HTTP request arrives at an operator-run listener, a mapping the operator wrote names ONE
pod, and that pod (a browser tab, a pod in Node, anything running `serveHttpOnMesh`) answers it with a
`(Request) => Response` handler. The response goes back to the HTTP client.

It is not a file server, not a CDN, not a registry of what is served, and not an egress proxy (`ServerSharing` /
`createProxyHandler` in `browsermesh-apps` go the other way: a peer asks THIS pod to fetch from a local server;
that stays separate). It adds no new framing: it is a protocol (`http`, version 1) on the existing protocol
channel, with bodies on the existing protocol streams.

## Threat model in one paragraph

The operator serves content they do not control. The provider is a pod somebody else runs; it can answer anything
at all. The HTTP client is anyone. The ingress is therefore a translating and *limiting* hop: it decides which pod
may answer (the mapping), refuses an answer from any other pod (pinning), bounds every dimension of what crosses
(bytes, time, concurrency, headers), strips what the HTTP side must not inherit from a provider (cookies,
redirects off the origin, active content), and never lets a client or a provider choose where a request goes.

One origin per provider is the operator's responsibility. Two providers behind one hostname share cookies,
storage and script reach in a browser; the response policy (inert content, no cookies) reduces that and the
mapping must not rely on it. The CLI refuses two different pods under one hostname.

## API

```js
import { createMeshIngress } from '@johnhenry/browsermesh-ingress'
import { listenNode } from '@johnhenry/browsermesh-ingress/node'

const ingress = createMeshIngress({
  service,                       // attachService(node, undefined, createMeshProtocolService()); or `node` to attach one
  resolve: async (request, { attempt, tried }) => ({ peer: podId, path?, headers?, response? }) | null,
  authorize: async (request, target) => boolean,   // optional; false -> 403
  deny: (request) => Response | true | null,       // optional; true -> 451
  limits: { ... },                                 // see "Defaults"
  methods: ['GET', 'HEAD'],
  forwardHeaders: [],            // extra request headers a client may pass to the provider
  exposeHeaders: [],             // extra response headers a provider may set
  verifyResponse: undefined,     // optional signed responses
  signRequest: undefined,        // optional signed requests (the provider's verifyRequest checks them)
  retry: undefined,              // optional { attempts, on, nonIdempotent }: see "Declining and retry"
  rpc: undefined,                // opt-in buffered fallback for a peer without the protocol
  onAudit: (record) => {},
})
await ingress.handle(request, { clientAddress })   // Request -> Response, web standard
ingress.stats(); await ingress.close()

const { port, close } = await listenNode(ingress, { port: 8080, host: '127.0.0.1', trustProxy: false })
```

`handle` is `(Request) => Promise<Response>` and uses only web-standard globals, so it runs in Node, Deno, Bun and
Workers. The core entry has no `node:` import (a test asserts it); `listenNode` is the separate `./node` entry.

Provider side:

```js
import { serveHttpOnMesh } from '@johnhenry/browsermesh-ingress'
const served = serveHttpOnMesh(service, (request, { peer, signal }) => new Response('hello'), {
  allowFrom: [ingressPodId],     // required; a pod not named is refused even if the registry would let it open
                                 // or (podId, context) => boolean | Promise<boolean>: see "allowFrom as a function"
  limits: { ... },
  sign: undefined,               // optional signed responses
  verifyRequest: undefined,      // optional: (request, { peer, sig, bytes }) => boolean, runs before the handler
})
registry.grantCapabilities(ingressPodId, ['protocol:http:open'])    // the registry grant is required too
```

`handler` is a function or `{ fetch(request, ctx) }`. A handler that cannot answer and has done no work returns
`declineRequest()`.

### `allowFrom` as a function, and signed requests

An ingress whose pod identity is new each session cannot be listed by id. `allowFrom` may then be a function
`(podId, context) => boolean | Promise<boolean>`, `context = { peer, protocol, version }`, asked on open and again for every
request; only `true` serves, and a throw or a rejection refuses. It stays required: omitting it is an error. **With a
function the provider's own check carries the weight**: the registry grant and the pod id no longer say which ingress this
is, so the provider decides by another proof. The provider's `verifyRequest(request, { peer, sig, bytes, rid, nonce })`
runs before the handler on a clone of the request and refuses anything but `true` (the channel error `request-unverified`,
a 502 `provider-refused-request` for the client); the ingress's `signRequest(bytes, { peer })` makes the `sig` in the
`fetch` head. The signed bytes (`signedRequestBytes`) are `{ v, dir: 'request', rid, nonce, host, method, target,
headers, client, digest }` with a fresh nonce per request, so a signature made for one request does not verify for
another; they are symmetrical to the response's (`dir` keeps the two apart). The package picks no cryptography.

### Declining and retry

A provider that cannot answer says so with `declineRequest()`: on the wire the head `{ status: 421, headers: [], body:
false, declined: true }`, which the ingress turns into the named failure `provider-declined` (502). It is never sent to
the client as the provider's own response (a handler's plain 421 is an ordinary answer; only the helper's object
declines, and a decline with headers, a body or a signature is refused as a bad head). An older ingress ignores
`declined` and shows its client an empty 421.

`retry: { attempts, on, nonIdempotent }` (off by default) re-asks `resolve`, with `{ attempt, tried }`, after a failure in
which the provider did no work: `provider-unreachable`, `provider-pin-mismatch`, `provider-declined` (all three by
default; nothing else can be named). `attempts` is 1 to 5, the whole request keeps one deadline, a mapping that returns
`null` or a pod already tried ends it with the original failure, and every attempt is mapped, authorised, rate-limited and
audited on its own (`attempt`, `retried: true`). Never after a provider started answering (its own error, a bad or missing
signature, a refused request, a stalled body); `POST` and `PATCH` only with `nonIdempotent: true`.

### Operator response headers

`response: { addHeaders: { name: value } }` in a mapping adds headers the operator wrote: at most 16, each value text of at
most 1024 bytes (4 KiB in all) with no control character, names that are tokens; no hop-by-hop or framing header
(`connection`, `transfer-encoding`, `upgrade`, `proxy-*`, `content-length`, `content-encoding`, ...); not a forced header
unless that header's own opt-out is set (`content-security-policy` with `contentSecurityPolicy: false`, `cache-control`
with `cacheControl: false`; `x-content-type-options` never; `set-cookie` with `allowSetCookie`). A bad one is a 500
`bad-mapping`, found before any provider is asked. They replace what the provider sent under the same name.

### How it relates to the existing serverless site service

`createSiteRequestHandler` / `createSiteMeshRpcService` (`browsermesh-apps`) serve a *site* (static, functions,
proxy handlers) to the mesh over `mesh-rpc`: buffered, base64 bodies, no per-peer authorisation of its own (the
handler owns it), the answer correlated to the peer it asked. `serveHttpOnMesh` does not replace it and does not
copy it. They relate in two honest ways:

- **Wrap (provider).** `fromSiteHandler(createSiteRequestHandler(siteConfig))` turns a site handler into a
  `(Request) => Response` handler (it decodes the site wire encoding with the existing `decodeWireResponse`). A
  site that already exists can therefore be offered over `http` without being rewritten, and gains streaming,
  cancellation, limits and the `protocol:http:open` grant.
- **Fallback (ingress, opt-in).** With `rpc: api` (a `createMeshRpcService` api on the site's envelope type) the
  ingress will, only when the provider does not serve the `http` protocol (`unknown-protocol`, or a pod that runs no
  protocol channel and never answers the open; never on a refusal), make one buffered request through mesh-rpc, and
  remember for a minute that the provider is of that kind. It is off by default because the legacy service has no
  default-deny: it answers any peer, so using it is the operator's explicit choice. Bodies, headers and the response
  policy are the same as on the `http` path; the answer is pinned to the pod the request went to by mesh-rpc itself.

`ServerSharing` is the opposite direction and is not touched.

## Wire: protocol `http`, version 1

Opened with `openProtocol(peer, 'http', { versions: [1] })`. Authorisation is `protocol:http:open` through the
provider's registry (default deny). Nothing else on the envelope changes.

Methods are on the channel (`http/<method>`), bodies on `createStreamLayer(channel)` (`stream.*`):

```
request  fetch   { rid, nonce, method, target, host, headers: [[name, value]...], body: bool, client?, sig? }
                 -> { status, headers: [[name, value]...], body: bool, sig?, declined? }
stream   meta { rid, kind: 'request' }     ingress -> provider, the request body (when body: true)
stream   meta { rid, kind: 'response' }    provider -> ingress, opened BEFORE the head is returned
```

- `rid` is chosen by the ingress; a stream whose `rid` the receiver does not expect is refused.
- `target` is a path and query (`/a?b=c`); `host` is the validated hostname the client used. The provider rebuilds
  the URL from parsed parts and refuses a target that is not origin-form.
- Backpressure: the stream layer's credit window. A slow HTTP client slows the provider; a reader that stops
  reading stops the writer at one window. Cancel: the client going away aborts the `fetch` request (the provider's
  handler `signal` aborts) and cancels the response stream (the provider's writes reject `stream-cancelled`).
- An older peer without the protocol answers `mesh.protocol.open` with `unknown-protocol`/`-32601`; nothing else
  is sent to it. A refusal (`not-authorized`) is never retried through the fallback.
- A provider that wants to sign sends `sig` in the head. Signing providers buffer the response (bounded) so the
  signature can cover the body digest. An ingress that signs requests sends `sig` in the request head; a provider that
  does not know it ignores it (an older provider simply does not verify), and `declined: true` is the provider's "not
  me" (above).
- **What it needs of the transport**: the channel is a protocol on a mesh link, so it needs only a byte duplex with a
  peer identity, and rides a relayed link as well as a direct one. On a link whose peer identity is only asserted by a
  third party, the signed-response and signed-request hooks should be mandatory in the application (all four set,
  unsigned answers and requests refused).

### Pinning

The answer is accepted only from the pod the mapping named:

- The channel is opened to `target.peer`; the link is that peer's verified session (the protocol channel's `peer` is
  the session key, never a field of a message). After opening, `channel.peer` must equal `target.peer` or the
  channel is closed and the request is refused (502 `provider-pin-mismatch`).
- Streams and heads arrive on that channel only; a `rid` is accepted from the channel it was issued on.
- **Routed (multi-hop) delivery is not part of v1.** The protocol channel rides direct links; a routed message is a
  different service. A pod with no direct link is refused (502 `provider-unreachable`). Carrying `http` over routed
  messages would need `requireSealed` end to end and the verified originator of each sealed message compared with
  the mapped pod before it is delivered to the channel; it is not built, and nothing here weakens that later.
- Optional response signing (`sign` on the provider, `verifyResponse` on the ingress) makes the pin independent of
  the transport: the ingress refuses (502 `response-unsigned` / `response-signature-invalid`) anything the hook
  does not accept.

## Defaults (each has a test)

| Rule | Default |
| --- | --- |
| Bind (Node listener, CLI) | `127.0.0.1`; CLI refuses non-loopback without `--public` and a TLS statement |
| Methods | `GET`, `HEAD`; others 405 with `Allow`; `CONNECT`/`TRACE` never |
| Request body cap | 64 KiB (413; declared `Content-Length` over the cap is refused before reading) |
| Body on GET/HEAD | 400 |
| Response cap | 8 MiB (502 `response-too-large`, or the stream is cut) |
| Total deadline | 30 s (504 `provider-timeout`) |
| Slow body | 10 s idle between request-body chunks (408) |
| Response idle | 15 s between response chunks |
| Header count / bytes | 64 / 16 KiB (431); URL target 2048 chars (414) |
| Global in-flight | 64 (503 + `Retry-After`) |
| Per-client in-flight / rate | 8 / 120 per minute (429) |
| Per-provider in-flight / rate | 16 / 600 per minute (503) |
| Request headers to the provider | allow-list (`accept`, `accept-language`, `content-type`, conditional and `range` headers); `forwardHeaders` adds; hop-by-hop, `Host`, `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`, `Upgrade`, `Proxy-*`, `Expect`, `Content-Length` never forwarded |
| Client address | the socket's; `trustProxy` (off) takes the last `X-Forwarded-For` entry of one trusted proxy |
| `Transfer-Encoding` with `Content-Length`, bad or repeated `Content-Length`, bad `Host` | 400 |
| `Upgrade` / WebSocket | 426 with a sentence |
| Response headers | allow-list; `Set-Cookie`, `Content-Encoding`, `Strict-Transport-Security`, `Refresh`, CORS and unknown headers dropped |
| Forced response headers | `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Vary` (provider's plus the forwarded request headers) |
| Redirects | never followed; a `Location` that is not an absolute path on the same origin makes the response 502 `provider-redirect-refused` |
| Provider URL | a peer never supplies a URL the ingress fetches; the ingress fetches nothing |
| Audit | `{ peer, host, method, status, reason?, requestBytes, responseBytes, durationMs }`; never query strings, paths or bodies |

A mapping can opt out of the response policy explicitly, per mapping, in `resolve`'s result:
`response: { contentSecurityPolicy: string | false, cacheControl: string | false, allowSetCookie: boolean, addHeaders: object }`.
The README carries the one table of every status and reason the ingress produces (pinned to the code by a test) and the
one table of the headers that cross by default.

## Not built in v1

- WebSocket (`Upgrade`) is refused with 426. A later bridge would map each upgrade onto `mesh-websocket` frames
  over a second protocol (`http-ws`), with the same pin, per-connection byte and idle limits, and an explicit
  `Origin` policy; none of that exists yet.
- Routed (multi-hop) delivery, as above: there is no multi-hop delivery; `retry` picks another named pod, it does not route.
- Streaming request bodies end to end while the client is still sending: the ingress reads the (capped) body first, so
  a slow client holds no provider resources; the body then crosses as a stream, and the provider reads it whole (also
  capped) before the handler runs, because a `ReadableStream` is not accepted as a `Request` body by every browser and a
  page is the usual provider. Response bodies do stream.
- Per-root authorisation on the provider (`http:<root>:<action>`): one grant, `protocol:http:open`, plus `allowFrom`.
- TLS: terminate it in front (a reverse proxy or a platform). The Node listener speaks plaintext HTTP/1.1.

## CLI

`browsermesh-ingress --listen 127.0.0.1:8080 --signaling wss://... --map host=podId [--map ...]`, with
`--allow-methods`, `--max-body`, `--timeout`, `--auth bearer:<file>`, `--identity <file>`, `--config file.json`,
`--public --tls-terminated-in-front`, `--help`. The mesh node uses `node-datachannel` when it is installed (an
optional dependency); without it nothing can connect to a pod, and the CLI says so.
