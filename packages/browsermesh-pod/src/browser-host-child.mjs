/**
 * browser-host-child.mjs — the pod-page side of the browser lane (issue
 * #185 item 7, deliverable A).
 *
 * `browser-host-driver.mjs`'s `createInPageDriver()` spawns a child page or
 * worker (an iframe, a `window.open()`ed window, or a dedicated `Worker`);
 * this is the ~20-line bootstrap THAT CHILD runs. It is deliberately tiny
 * and has no dependency on the driver module (a real pod page only needs
 * this file, `pod.mjs`'s `Pod`, and its own bundler): boot a `Pod` with a
 * `BroadcastChannelTransport` on the agreed discovery channel, then
 * broadcast a `browser-host:ready` announcement so a driver listening on
 * that channel can mark the pod `registered`.
 *
 * Carrying the pod's logical NAME (the one the orchestrator's podspec
 * named it, as opposed to its generated `podId`) is the one piece of
 * plumbing a plain `Pod` boot does not already do — `createHello()` has no
 * `name` field (see `messages.mjs`), and threading one through there would
 * touch the lane-agnostic wire protocol for a browser-lane-only concern.
 * The LEAST invasive option, used here: read `name` the same way a real
 * browsing context already carries it for free —
 *
 *   - iframe:  `iframe.name = spec.name` (an HTML attribute every iframe
 *     already has) → inside the frame, `window.name === spec.name`.
 *   - window:  `window.open(url, spec.name)` — the second argument IS the
 *     new window's `name` → `window.name === spec.name` there too.
 *   - worker:  `new Worker(url, { name: spec.name })` — a dedicated
 *     worker's global scope exposes that same option back as `self.name`.
 *
 * So `g.name` is the primary source in all three spawn kinds, with the
 * `#name=…` URL-hash convention the driver also writes into `podUrl` kept
 * as a fallback (useful for a page opened by hand, or a kind this module
 * does not special-case). Once booted, readiness is announced over the
 * pod's own public `broadcast()` — a plain `pod:message` to `'*'` with a
 * `{kind: 'browser-host:ready', name, podId}` payload — rather than a new
 * wire message type, so neither `messages.mjs` nor `pod.mjs` needed to
 * change for this lane to exist.
 */

import { Pod } from './pod.mjs'

/** The discovery-channel name `pod.mjs` itself defaults to, duplicated here
 * (it is not exported) so a child booted with no explicit `channel` still
 * lands on the same BroadcastChannel a same-origin driver listens on. */
export const DEFAULT_DISCOVERY_CHANNEL = 'pod-discovery'

/** The `payload.kind` a driver watches for on the discovery channel. */
export const BROWSER_HOST_READY = 'browser-host:ready'

/**
 * Read the pod's logical name off the global this code is running in.
 * @param {object} g
 * @returns {string|null}
 */
export function readPodName(g) {
  if (g && typeof g.name === 'string' && g.name) return g.name
  const href = (g?.location && (g.location.href || g.location.hash)) || ''
  const match = /[#?&]name=([^&]*)/.exec(href)
  return match ? decodeURIComponent(match[1]) : null
}

/**
 * Boot a `Pod` inside a page or worker a browser-lane `PodHostDriver`
 * spawned, and announce readiness on the discovery channel.
 *
 * @param {object} [opts]
 * @param {object} [opts.globalThis=globalThis] - Override for testing (a
 *   fake iframe/window/worker global); the real call site never passes
 *   this.
 * @param {string} [opts.channel] - BroadcastChannel name; must match the
 *   driver's `channel` option. Defaults to `DEFAULT_DISCOVERY_CHANNEL`,
 *   the same default `Pod#boot()` itself uses.
 * @param {string} [opts.name] - Override the name `readPodName()` would
 *   otherwise infer. Mostly for tests; real pages should let it be read
 *   from `g.name`/the URL.
 * @param {number} [opts.handshakeTimeout] - Forwarded to `Pod#boot()`.
 * @param {number} [opts.discoveryTimeout] - Forwarded to `Pod#boot()`.
 * @param {typeof Pod} [opts.PodClass=Pod] - Swap in a `Pod` subclass (e.g.
 *   `InjectedPod`) that boots the same way.
 * @returns {Promise<{pod: Pod, name: string|null}>}
 */
export async function bootHostedPod({
  globalThis: g = globalThis,
  channel = DEFAULT_DISCOVERY_CHANNEL,
  name,
  handshakeTimeout,
  discoveryTimeout,
  PodClass = Pod,
} = {}) {
  const resolvedName = name !== undefined ? name : readPodName(g)
  const pod = new PodClass()
  await pod.boot({
    globalThis: g,
    discoveryChannel: channel,
    ...(handshakeTimeout === undefined ? {} : { handshakeTimeout }),
    ...(discoveryTimeout === undefined ? {} : { discoveryTimeout }),
  })
  // A plain broadcast through the Pod's own public API -- no new wire
  // message type. A driver that is not listening (or is listening on a
  // different channel) simply never sees this; it is not a request that
  // needs an answer.
  try {
    pod.broadcast({ kind: BROWSER_HOST_READY, name: resolvedName, podId: pod.podId })
  } catch {
    // broadcast() throws if the transport never came up (e.g. no
    // BroadcastChannel in this global at all) -- the pod is still booted
    // and usable locally, it is just undiscoverable by a driver.
  }
  return { pod, name: resolvedName }
}
