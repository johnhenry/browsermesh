# Real-browser tests

`npm run test:browser` runs the mesh in a real browser (Playwright). Everything
else in this repository tests layers that need a network or an
`RTCPeerConnection` against an in-memory duplex or a mock; this suite is the
counterweight (issue #270).

```bash
npm ci
npx playwright install --with-deps chromium   # once; CI does this
npm run test:browser                          # Chromium
BM_BROWSERS=firefox,webkit npm run test:browser
```

Locally you may point Playwright at a browser you already have with
`PLAYWRIGHT_BROWSERS_PATH`; the version must match `@playwright/test`.

## How it works

- `server.mjs` is a dependency-free `node:http` server. It serves
  `packages/*/src` as plain ES modules, with an import map mapping each
  `@johnhenry/browsermesh-*` name to its entry file. No bundler.
- Every response carries a strict Content-Security-Policy with no
  `unsafe-eval`, no `unsafe-inline` and no `wasm-unsafe-eval` (the inline
  import map is allowed by a per-response nonce), plus COOP/COEP. A test
  proves eval is blocked, and every test fails on any CSP violation, page error
  or console error.
- The same server hosts `/relay`, `/signaling` and `/echo` WebSockets that
  speak the `browsermesh-servers` wire protocol. The real servers live in the
  sibling repository, so this is an in-repo test double, over a real socket.
  Two servers on two ports share one hub: two origins, one relay.
- `harness/bm.mjs` is the in-page side (`window.bm`). Tests orchestrate two
  pages, usually in two separate browser contexts, and wait with
  `page.waitForFunction` on synchronous predicates only. No wall-clock counts.

## Verified in a real browser

(How this fits with what is verified elsewhere, layer by layer:
[`docs/security.md`](../../docs/security.md#what-is-verified-how).)

- Ed25519 identity: generate, sign, verify across two browsers (WebCrypto).
- Pod discovery and messaging over BroadcastChannel, and invisibility across
  two origins.
- A real WebRTC data channel between two contexts through local signalling
  (host candidates over loopback, no STUN): open, both directions, 200 KB
  message, ordered burst, close, reconnect, ICE-restart renegotiation.
- The window message channel across two origins: a top page that listens to one
  frame accepts it and refuses another window of the same origin and a window of
  its own origin; a pod with no `window` option accepts nothing from any window.
  (`window-channel.spec.mjs`; the harness page is framed only when its URL asks
  for it with `?frame-src=` / `?frame-ancestors=`, otherwise it keeps
  `frame-ancestors 'none'`.)
- Pod messaging through the WebSocket relay, and the transport package's
  `WebSocketTransport` (text and 1 MiB binary).
- WebRTC identity binding on a real `RTCPeerConnection` (`webrtc-binding.spec.mjs`): both sides prove
  their pod key over the DTLS fingerprints read from real SDP, and the connection stays bound through an
  ICE restart; a peer that sends no proof is closed after the timeout with reason `timeout`; and with a
  signalling server that swaps the session descriptions for an attacker's, the connection is closed
  (`bad-signature`), while the same attack without binding goes unnoticed (the control). The attacker is a
  page with two `RTCPeerConnection`s of its own, handed every offer/answer/ICE frame by the test double
  (`hub.intercept`); it relays what crosses the data channel and cannot make a proof of its own.
  Passes in Chromium and Firefox; WebKit does not open a data channel in the local run (it also fails
  `webrtc.spec.mjs` there).
- mesh-rpc / `browserMeshFetch` and CRDT convergence over the real data channel.
- The message channel and the protocol seam (`createMeshProtocolService`) over the real data channel
  (`protocol-channel.spec.mjs`, #272): default deny and the `protocol:<name>:open` scope, the verified peer
  handlers see (the session's, not a message field), requests with a 900 KB binary result chunked across
  messages, progress, notifications, cancel (the callee's handler sees its `AbortSignal`), revocation closing
  the channel at once and a later grant reopening it, and credit-based flow control (a reader that stops
  reading holds the sender at one window; catching up delivers every message).
- The transport's main entry without wsh (`transport-no-wsh.spec.mjs`): a page whose import map has no
  `@johnhenry/wsh*` entry (`/?import-map=no-wsh`) imports `@johnhenry/browsermesh-transport` and requests no wsh
  module; the wsh features load only from the `/wsh` subpath.
- wsh's remote-object layer over a protocol channel (`@johnhenry/browsermesh-objects`, `objects.spec.mjs`):
  default deny, each operation judged by its own action (a peer granted `get` and `call` is refused `set`
  and a subscription), a 200 KB result chunked across messages, events in order, a one-way callback, a
  handle that never widens its path, revoking a subscription's grant ending the session at once and
  detaching the host's listener, and a reader that stops reading making the host drop events with every drop
  counted. The harness serves wsh's transport-neutral object core from `node_modules` (`/vendor/wsh/`).
- MCP across the mesh (`mcp-over-mesh.spec.mjs`, `docs/design/mcp-over-mesh.md`): one page registers WebMCP
  tools through wsh's capture shim and serves them on a protocol channel, another browser context lists and
  calls them over the real data channel. Default deny, per-tool list/call grants, revocation at once, a
  consequential tool asking the serving page (not the caller), a hostile result delivered as inert text with
  the untrusted label, cancel reaching the tool's signal, list-changed. wsh's browser-safe `page` entry is
  served from `node_modules` for this (`/vendor/wsh/`), the one third-party module the harness serves; the
  default DOM dialog of that bridge is not used (the harness answers with its own `prompt`).
- A page that answers real HTTP (`@johnhenry/browsermesh-ingress`, `ingress.spec.mjs`, `docs/design/http-ingress.md`):
  the page serves a `(Request) => Response` handler on the protocol `http`, the ingress and a Node listener run in
  the test process (a real `node-datachannel` peer for the page's own `RTCPeerConnection`, signalled through
  `/signaling`), and a real HTTP client talks to the listener. Default deny then a grant then a revocation, the
  verified ingress pod id as the only identity the handler sees, a POST body and a 600 KB answer in chunks, a
  page's cookie, policy and redirect not reaching the client, and a client that hangs up aborting the handler.
- A page as the consumer of a lent network (`@johnhenry/browsermesh-egress`, `egress.spec.mjs`,
  `docs/design/egress.md`): the egress provider runs in the test process on a real `node-datachannel` peer, the page
  asks it for TCP, a fetch and UDP, and the destinations are local servers. The protocol is refused until granted
  and every destination is refused by name until granted; granted, the bytes the destination sees are the bytes the page
  wrote, the fetch carries no cookie either way, and the audit has no payload. The provider's address guard (the operator
  lists only `127.0.0.1`) refuses another loopback address, the metadata address and a private one **even with a grant**,
  and refuses a redirect to the metadata address; the mail ports and a wildcard grant stay refused; a revocation takes
  effect on the next request, and a page that cancels a big body stops the destination.
- Examples 01, 02 and 05 unmodified in a page (their own transports stay
  simulated).
- The packages load and run under the strict policy above.

## Not verified here

- Anything needing STUN/TURN, NAT traversal, or a non-loopback network.
- The real `browsermesh-servers` relay/signalling (a test double stands in).
- WebTransport, GPU, service workers, IndexedDB-backed storage.
- Firefox and WebKit run in CI as allowed-to-fail legs.
- WebKit and WebRTC: WebKit replaces a host ICE candidate's address with a
  random `<uuid>.local` name that only multicast DNS can resolve, so two
  contexts could not connect (ICE never started) and the four data-channel
  tests timed out. Playwright's WebKit has no switch for this (Chromium and
  Firefox get one in `playwright.config.mjs`); WebKit stops hiding addresses
  while media capture is active, so under WebKit the harness grants the
  microphone and keeps a capture stream open while a connection is negotiated
  (`exposeHostCandidates()` in `fixtures.mjs`). That relies on Playwright's
  WebKit mock capture device, not on a real microphone, and it makes WebKit's
  candidates plain addresses rather than the obfuscated ones a real page
  would send, so what the WebKit legs prove is the data channel, not WebKit's
  default candidate privacy.
