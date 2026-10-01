# browser-pod-host spike

The browser lane's **CDP driver** (issue #185 item 7, deliverable B): a
`PodHostDriver` (`lane: 'browser'`) that spawns and controls pod pages in a
REAL browser over the Chrome DevTools Protocol, from outside it — a Node
process with a remote debugging port, not a page running inside the
browser (that is `@johnhenry/browsermesh-pod`'s `createInPageDriver()`;
see `docs/hosted-pods.md` §8b for how the three browser-lane drivers
compare).

Not a workspace member (root `workspaces` stays `packages/*`); plain ESM,
zero new runtime deps — no `puppeteer`, no `playwright`, no
`chrome-remote-interface`. CDP is JSON-RPC over one `WebSocket`, and
Node's global `WebSocket` (stable since Node 22) is all `src/cdp.mjs`
needs.

## Layout

- `src/cdp.mjs` — `findChromeExecutable()`, `launchChrome()` (spawns a real
  Chrome/Chromium with a throwaway profile and a remote debugging port,
  resolving once it prints `DevTools listening on ws://…`), and `connect()`
  (a minimal id-correlated CDP client with CDP "flat" multi-target session
  support — one WebSocket drives every attached target).
- `src/driver.mjs` — `createCdpDriver({cdp, podUrl, contextPerPod})`, the
  `PodHostDriver`.
- `src/host-pod.mjs` — `BrowserPodHost`, a `Pod` subclass wrapping
  launch + connect + driver into one host pod, mirroring
  `spikes/vm-pod-host/src/host-pod.mjs`'s `VmPodHost`.
- `static/pod.html` — the pod page every spawned target loads: an import
  map resolving `@johnhenry/browsermesh-primitives`'s bare specifier, then
  a module script calling the SAME `bootHostedPod()` the in-page driver's
  children use, publishing `window.__browsermeshHosted` for the driver to
  poll/evaluate against.
- `test/static-server.mjs` — a tiny `node:http` server (test-only) serving
  `static/pod.html` plus the `browsermesh-pod`/`browsermesh-primitives`
  source trees as real browser ES modules. `file://` does not work here:
  cross-module ES imports are blocked by CORS across `file://` origins in
  headless Chrome, so real HTTP it is.
- `test/cdp.test.mjs` — `connect()` against a fake `WebSocket`;
  `launchChrome()`/`findChromeExecutable()` against a fake `spawn()`.
- `test/driver.test.mjs` — `createCdpDriver()` against a fake `cdp` client
  (no browser).
- `test/e2e.test.mjs` — the real thing: launches Chrome itself (as a child
  process, killed in `after()` — no background process, no separate
  terminal session), spawns two browser-lane pods in separate browser
  contexts, execs, sends, lists, and drains. **Skips with a clear printed
  reason if no Chrome/Chromium is found** (`findChromeExecutable()` is
  checked before anything else runs).

## Run

```
npm test            # == node --test test/
```

Or individually: `node --test test/cdp.test.mjs`,
`node --test test/driver.test.mjs`, `node --test test/e2e.test.mjs`.

## Did it actually run against real Chrome?

**Yes.** Chrome search order: `CHROME_PATH` env var, then
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (and the
Chromium/Canary equivalents), then `PATH` (`google-chrome`, `chromium`,
etc). On the machine this was built and verified on (macOS, Chrome found
at the app-bundle path above), the e2e suite ran for real:

```
[e2e] using Chrome executable: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
[e2e] static server: http://127.0.0.1:65012
[e2e] chrome pid 14092, ready in 1857ms, ws://127.0.0.1:65019/devtools/browser/1b6ec7e6-...
[e2e] spawn(alpha) -> registered in 3321ms
[e2e] spawn(beta) -> registered in 2858ms
[e2e] exec(alpha, '1 + 1') -> {"stdout":"2","stderr":"","code":0} in 54ms
ℹ tests 8
ℹ pass 8
ℹ fail 0
ℹ duration_ms 20607
```

### Measured

| Measure | Observed | Note |
| --- | --- | --- |
| Chrome launch → DevTools listening | 1857 ms | `--headless=new`, fresh throwaway profile, cold start |
| `spawn()` → `registered` (1st pod) | 3321 ms | `Target.createBrowserContext` + `Target.createTarget` + `Target.attachToTarget` + polling `Runtime.evaluate` every 50ms for `window.__browsermeshHosted.ready` (set once `bootHostedPod()` resolves — including Ed25519 keypair generation and the pod's own short discovery wait) |
| `spawn()` → `registered` (2nd pod, separate context) | 2858 ms | about the same — isolation did not measurably add overhead |
| `exec('1 + 1')` round trip | 54 ms | one `Runtime.evaluate` call once the page is already registered |
| `drain()` (close target + dispose context) | part of an 8.4s test that ALSO calls `Target.getTargets()` twice to verify the target is really gone | the two `getTargets()` calls dominate that number, not `drain()` itself |

The ~3s `spawn → registered` number is dominated by `bootHostedPod()`'s own
work inside the page (ES module fetch + parse for `pod.mjs` and
`browsermesh-primitives`, real `PodIdentity.generate()` — an actual Ed25519
keypair over WebCrypto — plus the 50ms handshake/discovery waits
`static/pod.html` passes in) and by 50ms-interval polling rather than a
pushed readiness signal. A production version would very likely use
`Runtime.addBinding()` + an exposed binding call instead of polling to cut
the tail latency; this spike polls on purpose because it is simpler to
reason about and to test against a fake `cdp` (see `driver.mjs`'s module
doc comment).

If no Chrome is found, the suite logs e.g.:

```
[e2e] SKIPPING: no Chrome/Chromium executable found (checked CHROME_PATH, /Applications/Google Chrome.app, and PATH) — install one or set CHROME_PATH to run this suite
```

and every `it()` in that `describe` block reports `skipped`, not a failure.

## `exec` and `snapshot`/`restore` semantics (issue #185 item 7's decision)

**`exec` is supported here, unlike the in-page driver.** The browser
lane's `exec` means "evaluate an expression in the page's JS context," not
a shell command (see `host-protocol.mjs`'s `POD_LANE_VERBS` doc comment).
A CDP operator already has an out-of-band, fully-privileged channel into
the browser (the remote debugging port itself IS the trust boundary) —
there is no additional boundary being crossed the way there would be for a
page reaching into a sibling it spawned. `driver.exec(name, argv)` treats
`argv[0]` as the expression, runs `Runtime.evaluate` on that pod's session,
and returns `{stdout: JSON(result), stderr, code}`; an exception becomes
`{stdout: '', stderr: exceptionDetails.text, code: 1}`. When this driver is
wired through `createPodHostService()` (`@johnhenry/browsermesh-apps`),
`exec` is gated by `checkAccess()` exactly like `exec` on any other lane —
nothing here bypasses that.

**`snapshot`/`restore` are `ENOTSUP`**, not implemented this wave: no
durable serialization of a page's JS heap over CDP exists here. See the
extension driver's `chrome.tabs.discard`/reload pair
(`spikes/browser-extension-host`) for a real, but honestly weaker,
pause/resume primitive this lane could grow toward.

## Nesting with Lane B

`launchChrome()` does not care whether the Chrome binary it spawns is on
the operator's own machine or inside a Firecracker microVM guest a Lane B
host agent (`spikes/vm-pod-host`) launched — it is just
`child_process.spawn()` + a `ws://` URL. **"Firecracker runs headless
Chrome runs pod pages"** is this driver, pointed at a guest-side Chrome
instead of a host-side one; see `docs/hosted-pods.md` §8b for the diagram
and the full nesting note.

## Trust note

A CDP operator has full control over the browser it attaches to — that is
the whole point of this driver, and also why it is the right choice (over
the in-page driver) for running code you do NOT trust: put the Chrome
process this driver launches inside a Lane B microVM, so a hostile pod
page is contained by the guest/host boundary, not by browser same-origin
policy. See `docs/hosted-pods.md` §8b's "Trust caveat".
