# isolate-pod-host spike

Spike for [issue #185](https://github.com/johnhenry/browsermesh/issues/185)
("Hosted pods"), Work Package 2 (§8): can a `@johnhenry/browsermesh-pod`
`Pod` boot and stay discoverable inside a Cloudflare Durable Object / V8
isolate, using the existing relay + signaling servers from
`browsermesh-servers`, with no changes to either the pod package or the
servers?

**Answer: yes**, with one caveat that matters for the rest of the issue:
**WebSocket Hibernation does not apply to this topology** (see "What wasn't
achievable" below) — that's the single biggest finding here and it changes
what "sleeping pods" can mean for Lane A.

Not a published package, not part of the root `packages/*` npm workspaces —
this directory has its own `package.json` and `node_modules`.

## What this is

- `src/worker.mjs` — Worker entry. Routes `/pods/:name/{boot,status,send}`
  to a `PodObject` Durable Object, one instance per pod name
  (`env.POD.idFromName(name)`).
- `src/pod-object.mjs` — `PodObject extends DurableObject`. On `/boot`,
  loads (or generates + persists) an Ed25519 `PodIdentity`, boots a `Pod`
  from `@johnhenry/browsermesh-pod` on a `WebSocketTransport` against the
  relay/signaling servers, and arms a 30s keepalive alarm.
- `src/worker-websocket.mjs` — adapts workerd's fetch-with-`Upgrade`-header
  outbound WebSocket pattern to the `new WebSocket(url)` constructor shape
  `WebSocketTransport` expects, so the same transport runs unmodified in
  Node (global `WebSocket`) and workerd (this wrapper).
- `src/identity-jwk.mjs` — the "smallest possible helper" the issue asks
  for (§8 WP2): JWK import/export for `PodIdentity`, since the package has
  no "load an existing keypair" path yet (only `generate()`).
- `wrangler.toml` / `workerd.config.capnp` — Cloudflare-account path and
  self-hosted (no-account) path, respectively.
- `test/isolate-pod.test.mjs` — end-to-end `node --test` harness; spawns
  the relay, the signaling server, and `wrangler dev` as real child
  processes, boots a Node pod and a DO pod, and asserts mutual discovery +
  measures timings.

## How to run

```sh
cd spikes/isolate-pod-host
npm install

# Local dev server against a relay + signaling pair you start yourself:
#   (from the repo root, in two other terminals)
#   PORT=8788 node browsermesh-servers/relay/index.mjs
#   PORT=8787 node browsermesh-servers/signaling/index.mjs
npm run dev            # wrangler dev, serves on :8787... (wrangler picks a port)

# Bundling / binding sanity check without starting a server:
npm run dry-run        # wrangler deploy --dry-run --outdir dist

# Full end-to-end test (spawns relay + signaling + wrangler dev itself):
npm test               # node --test test/
```

Once running, boot a pod and check its status:

```sh
curl -X POST http://localhost:<port>/pods/alpha/boot
curl http://localhost:<port>/pods/alpha/status
curl -X POST http://localhost:<port>/pods/alpha/send \
  -H 'content-type: application/json' \
  -d '{"to": "<some-other-podId>", "payload": {"hello": "world"}}'
```

### Running self-hosted (workerd, no Cloudflare account)

`workerd.config.capnp` declares the same `PodObject` Durable Object outside
of `wrangler`/Cloudflare entirely:

```sh
npx workerd serve workerd.config.capnp
```

The config file embeds `src/*.mjs` directly as `esModule` entries, which is
enough to run `worker.mjs` and `pod-object.mjs`'s own logic, **but it
cannot resolve the bare `@johnhenry/browsermesh-pod` /
`@johnhenry/browsermesh-primitives` specifiers** the way `wrangler dev`'s
esbuild-based bundler does — hand-written `.capnp` module lists don't do
module resolution. The config file has a long comment with the two ways to
fix this (pre-bundle with esbuild, or vendor the package `.mjs` files in as
more `embed` modules); neither was necessary to answer the spike's actual
question, since `wrangler dev` / `wrangler deploy --dry-run` already prove
the worker bundles and runs correctly against the real packages. Treat
`workerd.config.capnp` as a documented, one-step-away path rather than a
turnkey one.

## Measured numbers

All measurements from `node --test test/` on this machine (Apple Silicon
macOS, Node v26.9.0, wrangler 4.145.0, workerd 2026-09-30), relay +
signaling + `wrangler dev` all on localhost loopback. Re-run `npm test` to
reproduce — numbers are printed as test diagnostics.

| Measure | Issue #185 §9 target | Measured | Notes |
| --- | --- | --- | --- |
| Spawn → registered on relay+signaling | < 100 ms | **~35 ms** | Time from `/boot` request to `WebSocketTransport.ready` (both relay and signaling handshakes complete). Measured independently of `Pod.boot()`'s own wait (see next row) by polling `transport.ready`. |
| `Pod.boot()` wall time (what `/boot` actually returns in) | — | **~1535 ms** | Dominated entirely by `TransportDiscovery.start()`, which does a **fixed, unconditional `setTimeout(resolve, timeout)`** regardless of how fast peers answer (`packages/browsermesh-pod/src/discovery.mjs`) — not by connection or registration latency. We left the discovery timeout at its default-ish 1500ms for the spike; a hosted-pod-specific profile would plausibly shorten it, since the point-to-point relay fan-out means there's no "still waiting for stragglers" reason to hold the window open as long as a wide broadcast network might need. |
| Node-process pod boot (for comparison) | — | ~1509 ms | Same fixed-discovery-window cost, confirms it's a `Pod`/`TransportDiscovery` property, not a workerd one. |
| Memory per idle pod | < 5 MB | **not measured** | `wrangler dev --local` does not expose per-isolate memory; Cloudflare's dashboard/analytics only report this for pods deployed to the real edge (GB-seconds billing), which is out of scope for a local spike. Flagged as a WP4/production follow-up. |
| Wake on message after idle | < 50 ms (via hibernation) | **≈ same as cold boot (~1.5s)** | See "What wasn't achievable" — hibernation does not apply to this topology, so there is no fast-resume path. Verified empirically: killed and restarted the `wrangler dev` process (simulating an isolate restart) and re-booted the same pod name; the identity was correctly reloaded from storage (same `podId` both times) but the second boot took 1522ms vs. 1533ms for the first — statistically indistinguishable. |
| Message RTT, Node pod ↔ DO pod, via relay | < 2× browser↔browser via relay | **1–2 ms** | Loopback-only; no browser↔browser relay baseline was measured in this spike to compare against, and production RTT will include real network latency on both legs. Directionally very good — the relay hop itself adds negligible overhead. |
| `wrangler dev` cold start (process spawn → `/health` 200) | — | **~1.0–1.1 s** | Not a pod metric, but it's the dominant fixed cost in the test suite's wall time and worth recording for anyone trying to reproduce quickly. |

## What was and wasn't achievable

### Achieved
- A `Pod` from `@johnhenry/browsermesh-pod` boots, unmodified, inside a
  Durable Object, using only the existing relay + signaling servers — no
  server-side changes, confirming issue #185 §1's claim that
  `detectPodKind()` already does the right thing for non-browser contexts
  (**with one correction, below**).
- Ed25519 keypair persistence across Durable Object evictions/restarts via
  JWK in `ctx.storage`, confirmed by restarting the whole `wrangler dev`
  process and observing the same `podId` come back.
- Mutual discovery between a DO-hosted pod and a plain Node pod through the
  relay's point-to-point-only protocol, using the signaling server's
  `peers`/`peer-joined` frames as the fan-out list issue #185 §4.1 proposed
  as "the spike path" (option (b)) — no relay changes needed.
- A message round trip (ping → pong) through the relay in 1–2ms.
- `wrangler deploy --dry-run` and `wrangler dev` both bundle
  `../../packages/browsermesh-pod/src/index.mjs` and
  `../../packages/browsermesh-primitives/src/index.mjs` with zero changes
  to either package — confirms issue #185 §1's "zero Clawser imports,
  plain ESM, zero deps" premise holds up against esbuild's Workers target.

### Not achieved / not applicable

**WebSocket Hibernation does not apply to this topology, and that's
structural, not a missing feature.** The Hibernation API only covers
WebSocket connections a Durable Object *accepts* as a server (via
`ctx.acceptWebSocket()` on a `WebSocketPair`, documented at
developers.cloudflare.com/durable-objects/best-practices/websockets/).
`PodObject` connects *out* to the relay and signaling servers — it is a
WebSocket *client* in both relationships. Cloudflare's own docs are
explicit that "hibernation is only supported when a Durable Object acts as
a WebSocket server" and that "an open outbound WebSocket connection
prevents eviction for up to 15 minutes" — i.e. our topology's outbound
connections actively *pin* the DO in memory rather than letting it sleep.
Issue #185 §4.2's sequence diagram ("idle → WebSocket hibernation; DO
evicted from memory") describes the Cloudflare Durable Objects ideal, not
what this spike's relay-based topology can deliver.

This is the load-bearing finding for the rest of the issue: **as long as
isolate pods reach the mesh by dialing out to the relay, "sleeping pods
that wake on a message" (issue #185 §1, point 5) is not a free primitive —
it costs the same as a cold boot (~1.5s here, almost entirely the fixed
discovery window, not the network handshake).** Getting hibernation back
would require inverting the connection direction — browser/Node peers
connecting directly *to* the DO (which then accepts their WebSocket and can
hibernate between messages) instead of everyone dialing a shared relay.
That's a real topology change (the relay becomes optional for isolate pods
specifically, peers need the DO's address instead of just its `podId`,
and the "no new servers" simplicity from issue #185 §3 no longer holds
for this lane) — worth a follow-up spike of its own, not a tweak to this
one.

**`detectPodKind()` classifies workerd as `'service-worker'`, not
`'server'`.** Issue #185 §1 states "`detectPodKind()` returns `'server'`
whenever there is no `window`/`document`". That's true in Node, but
`packages/browsermesh-pod/src/detect-kind.mjs` checks
`g instanceof g.ServiceWorkerGlobalScope` *first*, and workerd's
`globalThis` satisfies that check (Workers' API surface descends from the
Service Worker API). Confirmed via the `/status` endpoint's `kind` field in
every test run: `"kind":"service-worker"`. This doesn't break anything here
— `detectCapabilities()` and the rest of the boot sequence don't branch on
`kind` in any way that matters for a hosted pod — but it means any future
code that special-cases `kind === 'server'` for "non-browser host" logic
needs `kind === 'service-worker'` too, or detect-kind.mjs needs a workerd
-specific check inserted before the ServiceWorkerGlobalScope check (open
question for WP5's design doc, not something this spike changes, per the
task rules — no package edits from the spike).

**Memory-per-idle-pod is not measured.** Local `wrangler dev` has no
per-isolate memory reporting; this needs an actual deployed Worker and
Cloudflare's analytics/GB-seconds billing to measure honestly. Flagged as a
production-deployment follow-up, not attempted here.

**Keypair persistence uses extractable JWK keys, as the issue explicitly
allows for the spike** (§8 WP2: "store as JWK; extractable is acceptable
for the spike"). `src/identity-jwk.mjs` documents why this is the same
"host can always read a hosted pod's key" limitation issue #185 §7 already
names generally, not a new one introduced by this choice.

## Exact follow-ups

1. ~~Land WP1~~ Done: this spike imports `WebSocketTransport` from `@johnhenry/browsermesh-pod` (merged in the same wave).
2. **Spike the inverted topology** (peers connect directly to the DO,
   which accepts and can hibernate) as a separate follow-up, specifically
   to get a real "wake on message after idle" number under 50ms. This is
   the only path to the sleeping-pod primitive issue #185 §1 point 5
   promises for Lane A.
3. **Measure memory-per-idle-pod and true cold-start latency against a
   real Cloudflare account** (not `wrangler dev --local` / self-hosted
   `workerd`), since both numbers in issue #185 §9's table assume
   production placement, not local dev.
4. **Reconsider `TransportDiscovery`'s fixed discovery window for hosted
   pods.** The ~1.5s `Pod.boot()` cost measured here is a `Pod`/
   `TransportDiscovery` design choice (unconditional `setTimeout`), not an
   infrastructure limitation — the actual relay+signaling handshake takes
   ~35ms. Worth a short, separate conversation (not a code change from
   this spike) about whether hosted pods should get a shorter default
   timeout, or whether `TransportDiscovery` should resolve early once at
   least one `hello-ack` is seen, with the full timeout only as a ceiling.
5. **Feed the `detectPodKind()` finding into WP5's design doc** — document
   that hosted isolate pods report `kind: 'service-worker'`, not
   `'server'`, and decide whether `detect-kind.mjs` needs a workerd-
   specific branch before any code starts branching on `kind === 'server'`
   for "this is a hosted, non-browser pod" logic.
6. **`execOnPod` isolate guard (WP4)** is unaffected by anything found
   here — this spike never attempted shell execution, consistent with
   issue #185 §6 point 3 (isolate pods should reject it outright).
