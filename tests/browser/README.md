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
- Pod messaging through the WebSocket relay, and the transport package's
  `WebSocketTransport` (text and 1 MiB binary).
- mesh-rpc / `browserMeshFetch` and CRDT convergence over the real data channel.
- Examples 01, 02 and 05 unmodified in a page (their own transports stay
  simulated).
- The packages load and run under the strict policy above.

## Not verified here

- Anything needing STUN/TURN, NAT traversal, or a non-loopback network.
- The real `browsermesh-servers` relay/signalling (a test double stands in).
- WebTransport, GPU, service workers, IndexedDB-backed storage.
- Firefox and WebKit run in CI as allowed-to-fail legs and have not been run
  locally.
