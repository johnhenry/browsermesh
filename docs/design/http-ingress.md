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
  resolve: async (request) => ({ peer: podId, path?, headers?, response? }) | null,
  authorize: async (request, target) => boolean,   // optional; false -> 403
  deny: (request) => Response | true | null,       // optional; true -> 451
  limits: { ... },                                 // see "Defaults"
  methods: ['GET', 'HEAD'],
  forwardHeaders: [],            // extra request headers a client may pass to the provider
  verifyResponse: undefined,     // optional signed responses
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
  limits: { ... },
  sign: undefined,               // optional signed responses
})
registry.grantCapabilities(ingressPodId, ['protocol:http:open'])    // the registry grant is required too
```

`handler` is a function or `{ fetch(request, ctx) }`.

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
  ingress will, only when the provider does not serve the `http` protocol (`unknown-protocol`, never on a refusal),
  make one buffered request through mesh-rpc. It is off by default because the legacy service has no
  default-deny: it answers any peer, so using it is the operator's explicit choice. Bodies are capped by the same
  limits; the answer is pinned to the pod the request went to by mesh-rpc itself.

`ServerSharing` is the opposite direction and is not touched.

## Wire: protocol `http`, version 1

Opened with `openProtocol(peer, 'http', { versions: [1] })`. Authorisation is `protocol:http:open` through the
provider's registry (default deny). Nothing else on the envelope changes.

Methods are on the channel (`http/<method>`), bodies on `createStreamLayer(channel)` (`stream.*`):

```
request  fetch   { rid, method, target, host, headers: [[name, value]...], body: bool, client? }
                 -> { status, headers: [[name, value]...], body: bool, sig? }
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
  signature can cover the body digest.

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
| Forced response headers | `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Vary` (provider's plus the forwarded request headers) |
| Redirects | never followed; a `Location` that is not an absolute path on the same origin makes the response 502 `provider-redirect-refused` |
| Provider URL | a peer never supplies a URL the ingress fetches; the ingress fetches nothing |
| Audit | `{ peer, host, method, status, reason?, requestBytes, responseBytes, durationMs }`; never query strings, paths or bodies |

A mapping can opt out of the response policy explicitly, per mapping, in `resolve`'s result:
`response: { contentSecurityPolicy: string | false, cacheControl: string | false, allowSetCookie: boolean }`.

## Not built in v1

- WebSocket (`Upgrade`) is refused with 426. A later bridge would map each upgrade onto `mesh-websocket` frames
  over a second protocol (`http-ws`), with the same pin, per-connection byte and idle limits, and an explicit
  `Origin` policy; none of that exists yet.
- Routed (multi-hop) delivery, as above.
- Streaming request bodies to the provider while the client is still sending: the ingress reads the (capped) body
  first, so a slow client holds no provider resources; the body then crosses as a stream.
- Per-root authorisation on the provider (`http:<root>:<action>`): one grant, `protocol:http:open`, plus `allowFrom`.
- TLS: terminate it in front (a reverse proxy or a platform). The Node listener speaks plaintext HTTP/1.1.

## CLI

`browsermesh-ingress --listen 127.0.0.1:8080 --signaling wss://... --map host=podId [--map ...]`, with
`--allow-methods`, `--max-body`, `--timeout`, `--auth bearer:<file>`, `--identity <file>`, `--config file.json`,
`--public --tls-terminated-in-front`, `--help`. The mesh node uses `node-datachannel` when it is installed (an
optional dependency); without it nothing can connect to a pod, and the CLI says so.
