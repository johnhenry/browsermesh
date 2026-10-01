---
"@johnhenry/browsermesh-pod": minor
---

Add the browser lane's in-page `PodHostDriver` (issue #185 item 7): spawning and controlling pages (iframes, `window.open()` windows, dedicated workers) that each boot a `Pod`, from inside a browser tab, with zero new dependencies.

- `createInPageDriver({podUrl, spawnKind, channel, ...})` in `src/browser-host-driver.mjs` — `lane: 'browser'`, serving `spawn`/`status`/`send`/`drain`/`list` via `iframe`/`window.open`/`Worker` plus a shared `BroadcastChannel` for the `browser-host:ready` handshake, and `postMessage` for `send`. `exec`/`snapshot`/`restore` are `ENOTSUP`: a parent tab has no safe way to evaluate code in a child it spawned (same-origin or not), and no durable page-heap snapshot exists yet.
- `bootHostedPod({globalThis, channel, name})` and `readPodName(g)` in `src/browser-host-child.mjs` — the ~20-line bootstrap any pod page or worker runs to boot a `Pod` and announce itself, reading its name from `window.name`/`self.name`/a `#name=…` URL-hash fallback so no new field was needed on `createHello()`.
- `POD_LANE_VERBS[POD_LANE.BROWSER]` now includes `exec`: the browser lane decision is that `exec` means **"evaluate an expression in the page's JS context,"** not a shell command, and that is a real lane-level capability (the CDP and extension drivers in `spikes/browser-pod-host` / `spikes/browser-extension-host` implement it) even though this package's own in-page driver does not. `snapshot`/`restore` stay `ELANE` on the browser lane.

See `docs/hosted-pods.md` §8b for the full three-driver picture (in-page, CDP, extension) and the trust caveat: a tab is not a privilege boundary against the page it hosts.
