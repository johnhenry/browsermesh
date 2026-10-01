# browser-extension-host spike

The browser lane's **extension** driver (issue #185 item 7, deliverable
C): a Manifest V3 extension whose background service worker runs a
`PodHostDriver` (`lane: 'browser'`) driving pod pages through
`chrome.tabs`/`chrome.scripting`/`chrome.storage`. See
`docs/hosted-pods.md` §8b for how this compares to the in-page driver
(`@johnhenry/browsermesh-pod`) and the CDP driver
(`spikes/browser-pod-host`).

Not a workspace member; plain ESM; zero new runtime deps.

## Layout

- `manifest.json` — MV3, `permissions: ["tabs", "scripting", "storage"]`,
  `host_permissions` scoped to the pod page's origin (placeholder:
  `https://pods.example/*` — change this to whatever origin you actually
  serve pod pages from), module service worker.
- `src/background.mjs` — the service worker: boots a `Pod` representing
  the extension itself (kind `service-worker`), constructs
  `createExtensionDriver({chrome})`, hydrates its roster from
  `chrome.storage.session` on every (re)start, and exposes a convenience
  `chrome.runtime.onMessage` relay (`pod-host:<verb>`) for manual testing.
- `src/driver.mjs` — `createExtensionDriver({chrome, podUrl})`, the
  `PodHostDriver`. Fully covered by `test/driver.test.mjs` against a fake
  `chrome`.
- `src/content.mjs` — the content script bridging `chrome.runtime` ↔ the
  pod page, for BOTH spawn modes `driver.mjs` supports (see "Spawn modes"
  below).
- `test/driver.test.mjs` — every verb, against a fake `chrome.tabs`/
  `chrome.scripting`/`chrome.storage`/`chrome.runtime`.

## Run (the testable part)

```
npm test   # == node --test test/
```

17 tests, all against the fake `chrome` — `driver.mjs`'s actual logic, not
the extension loading mechanics.

## The extension cannot be loaded in CI

There is no headless "load an unpacked MV3 extension and drive it"
automation in this repo (unlike `spikes/browser-pod-host`, which launches
real headless Chrome directly — an extension additionally needs Chrome's
extension-loading UI/flags, a packed or unpacked install, and
`host_permissions` matching a real served origin). `manifest.json`,
`background.mjs`, and `content.mjs` are real, loadable code, but nothing
here automatically verifies they work together inside an actual browser.

### Manual load instructions

1. Serve a pod page (e.g. `spikes/browser-pod-host/static/pod.html` plus
   its static server, or your own) at the origin you put in
   `manifest.json`'s `host_permissions` and `content_scripts.matches`
   (default: `https://pods.example/*` — for local testing, point these at
   `http://localhost:<port>/*` instead and update both fields).
2. Open `chrome://extensions`.
3. Enable "Developer mode" (top-right toggle).
4. Click "Load unpacked", select this directory
   (`spikes/browser-extension-host/`).
5. Open the extension's service worker DevTools ("service worker" link on
   the extension's card) to see `background.mjs`'s console output.
6. From that service worker console (or any page, via
   `chrome.runtime.sendMessage(extensionId, {...})`), drive it:
   ```js
   chrome.runtime.sendMessage(EXTENSION_ID, {
     type: 'pod-host:spawn',
     args: [{ name: 'tab-1', lane: 'browser', run: { kind: 'module', ref: 'pod-page' } }],
   }, console.log)
   ```

## Spawn modes (`run.input.mode`)

The task framing for this driver describes two spawn styles as
`spec.run.kind: 'page'` vs `'inject'`. That collides with the shared
protocol: `validatePodSpec()`'s `run.kind` is a closed enum
(`skill`/`module`/`rootfs`/`command`) — a `'page'`/`'inject'` value fails
podspec validation before this driver ever sees it. `run.input` is the one
field the protocol passes through unvalidated, so the mode lives there
instead:

- **default (no `run.input.mode`, or anything other than `'inject'`)** —
  the pod page is assumed to boot itself, the same way
  `spikes/browser-pod-host/static/pod.html` does (importing `bootHostedPod()`
  and announcing over `BroadcastChannel`). `content.mjs` listens on that
  SAME channel/origin from its isolated world and relays readiness/messages
  — no new wire protocol needed, since `BroadcastChannel` is scoped by
  origin + channel name, not by JS world.
- **`run.input.mode: 'inject'`** — `driver.mjs`'s `spawn()` calls
  `chrome.scripting.executeScript({world: 'MAIN', func, args})` to inject a
  bootstrap into the page's own JS realm. The shipped stub
  (`injectedReadyStub` in `driver.mjs`) is deliberately minimal — just
  enough to prove the injection mechanics and pass `test/driver.test.mjs`
  — and is **not** a real `InjectedPod` bootstrap. A production version
  would inject code that constructs `InjectedPod({extensionBridge})`
  (`@johnhenry/browsermesh-pod`'s `InjectedPod`, built for exactly this)
  with a bridge object whose `postMessage(msg)` forwards through
  `window.postMessage` to `content.mjs`'s listener (`BRIDGE_MARKER` in
  `content.mjs`), which re-wraps it onto the `chrome.runtime.connect()`
  port to `background.mjs`. **What's not implemented**: that real
  main-world bootstrap script itself — `content.mjs`'s port-bridging half
  of this path is written and would work once paired with it, but nothing
  in this spike builds the injected bundle (it would need `InjectedPod`'s
  module graph available to `chrome.scripting.executeScript`, which means
  either bundling it or injecting a `<script type="module" src="...">` tag
  instead of a `func`).

## `exec` semantics (issue #185 item 7's decision)

**Supported**, like the CDP driver and unlike the in-page driver: the
extension has `scripting` permission and `host_permissions` scoped to the
pod page's origin — a real, narrower-than-CDP privilege boundary (an
extension can only touch pages its manifest named), but still external to
the page itself, same reasoning the CDP driver gives. `exec(name, argv)`
treats `argv[0]` as a JS expression, evaluates it via
`chrome.scripting.executeScript({world: 'ISOLATED', func, args})` (never
colliding with the page's own main-world globals), and returns
`{stdout: JSON(result), stderr, code}`. Once this driver is wired into
`createPodHostService()` (`@johnhenry/browsermesh-apps`), `exec` is gated
by `checkAccess()` exactly like `exec` on any other lane.

## `snapshot`/`restore` semantics — the honest version

`snapshot` calls `chrome.tabs.discard(tabId)` — a REAL Chrome feature that
frees a background tab's memory. `restore` calls `chrome.tabs.reload(tabId)`
to un-discard it. Both are exposed as `snapshot`/`restore` (DECISION, issue
#185 item 7), because "free this tab's memory, resume means reboot" is a
real and useful capability — but it is a **weaker promise** than what
`snapshot`/`restore` mean everywhere else in this protocol:

- A microVM snapshot (`spikes/vm-pod-host`) preserves the guest's full
  memory image byte-for-byte; restoring resumes exactly where execution
  left off, same `podId`, same everything.
- `chrome.tabs.discard()` does **not** preserve the page's JS heap at all.
  Reactivating a discarded tab **navigates fresh** — `restore()` reboots
  the pod page from scratch. The restored pod has a **DIFFERENT generated
  `podId`** than the one that was snapshotted (`test/driver.test.mjs`'s
  `snapshot()/restore()` test asserts exactly this). Any state the pod
  held in memory is gone; only what it durably persisted elsewhere (e.g.
  IndexedDB) survives.

A caller that needs real state preservation across a pause must not treat
this pair as a substitute for Lane B's microVM snapshot. `POD_LANE_VERBS[POD_LANE.BROWSER]`
(`host-protocol.mjs`) does **not** include `snapshot`/`restore` — the
browser lane as a whole stays `ELANE` for them — so this driver's pair is
**not** wired into `createPodHostService()` in this spike; it is reachable
only by calling the driver directly (or via `background.mjs`'s
`pod-host:snapshot`/`pod-host:restore` convenience relay).

One more honesty note, found while writing this: `pod-host-service.mjs`'s
`verbRefusal()` checks "does the driver itself implement + declare the
verb" **before** consulting `laneSupports()`. That means if this driver
(as-is, with `snapshot`/`restore` in its `capabilities().verbs`) were
attached to `createPodHostService()`, those two verbs WOULD be let through
the gate despite the browser lane excluding them at the protocol level —
a real soft spot in the existing dispatch order, not something this spike
works around. Worth closing (e.g., having the service also check
`laneSupports()` even when a driver claims support) before this driver
graduates past spike status.

## Persistence across service-worker restarts

MV3 background service workers are killed and restarted by the browser
whenever idle — an in-memory `Map` alone loses the pod roster on every
restart. `driver.mjs` writes the roster to `chrome.storage.session` (not
`chrome.storage.local`: a roster describing live tabs should not outlive
the browser session that owns them) after every mutation, and exposes
`driver.hydrate()` — call it once after constructing the driver in a
freshly (re)started service worker, before serving requests.
`test/driver.test.mjs`'s last test exercises this directly.
