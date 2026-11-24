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
forwardClientAddress?, verifyResponse?, rpc?, onAudit?, clock? })` returns `{ handle(request, { clientAddress }),
stats(), close() }`.

- `resolve(request) -> Promise<{ peer, path?, headers?, response? } | null>`: `peer` is the pod id the answer is pinned
  to; `path` replaces the request's path (the query is kept); `headers` are added to what the provider is sent;
  `response` is `{ contentSecurityPolicy, cacheControl, allowSetCookie }` to opt this mapping out of the response policy
  (`nosniff` is not optional). `null` is a 404.
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

`handler` is a function or `{ fetch }`. `peer` is the ingress pod, the channel's verified peer (never a header);
`signal` aborts when the client goes away or the deadline passes. `request.url` is `http://<the client's host><path>`.
A request body is read whole (bounded) before the handler runs, so it works in every browser; response bodies stream.

`fromSiteHandler(createSiteRequestHandler(siteConfig))` serves a serverless site (`browsermesh-apps`) over `http`
without rewriting it (wrap, not replace: the legacy service keeps working over mesh-rpc).

### Signed responses (optional)

`serveHttpOnMesh(..., { sign: async (bytes, { peer }) => signature })` and
`createMeshIngress({ verifyResponse: async ({ peer, bytes, sig }) => boolean })`. The signed bytes (`signedBytes()` in
the source) are the request's id and a fresh nonce, host, method and target, the status, the headers as the provider sent
them and the SHA-256 of the body; the provider buffers a signed response. A response with no signature, or one the hook
does not accept, is a 502 (`response-unsigned`, `response-signature-invalid`). The package chooses no cryptography.

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
| Forced | `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Vary` |
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
client? } -> { status, headers, body, sig? }`; bodies are protocol streams (`{ rid, kind: 'request' }` ingress to
provider, `{ rid, kind: 'response' }` opened by the provider before it answers). No new framing; a peer without the
protocol answers the open with `unknown-protocol` and is sent nothing else. Design: [`docs/design/http-ingress.md`](../../docs/design/http-ingress.md);
threat model: [`docs/security.md`](../../docs/security.md#http-ingress).
