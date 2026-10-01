/**
 * content.mjs — the content script bridging `chrome.runtime` ↔ the pod
 * page, for both spawn modes `driver.mjs` supports (issue #185 item 7,
 * deliverable C).
 *
 * CANNOT BE LOADED IN CI — see README.md. Real, loadable code; no
 * automated coverage.
 *
 * A content script runs in an ISOLATED JS world: same DOM, same origin
 * (so same-origin platform APIs like `BroadcastChannel` ARE shared with
 * the page), but a SEPARATE global object -- it cannot read a `window.foo`
 * the page's own main-world script set, or call a function the page
 * defined, directly. Two different bridges follow from that, one per
 * spawn mode:
 *
 *   - **`run.input.mode` absent (page boots itself)** — the pod page calls
 *     `bootHostedPod()` the same way the in-page driver's children do,
 *     broadcasting `browser-host:ready` over `BroadcastChannel('pod-discovery')`.
 *     `BroadcastChannel` is scoped by origin + channel name, not by JS
 *     world, so THIS content script can open its own instance of the SAME
 *     channel and both hear that announcement and relay `send()` payloads
 *     onto it using the exact same `pod:message` shape the pod's own `Pod`
 *     already understands -- no new wire protocol needed.
 *   - **`run.input.mode: 'inject'`** — `driver.mjs`'s `spawn()` injects a
 *     bootstrap into the MAIN world via `chrome.scripting.executeScript`.
 *     That bootstrap is expected to construct an `InjectedPod({extensionBridge})`
 *     whose bridge forwards through `window.postMessage` (the one channel
 *     that DOES cross JS worlds) to THIS content script, which re-wraps it
 *     onto a `chrome.runtime.connect()` port to `background.mjs`.
 *
 * This file implements both, but the 'inject' path's main-world bootstrap
 * itself (constructing the real `InjectedPod`) is NOT included here -- see
 * the README's "What's not implemented" section.
 */

const DISCOVERY_CHANNEL = 'pod-discovery'
const READY_KIND = 'browser-host:ready'
const BRIDGE_MARKER = '__browsermesh_extension_bridge__'

// ---------------------------------------------------------------------------
// Page-boots-itself mode: BroadcastChannel readiness + message relay.
// ---------------------------------------------------------------------------

let lastReady = null // {podId, name} once a browser-host:ready broadcast is seen
const channel = new BroadcastChannel(DISCOVERY_CHANNEL)
channel.onmessage = (event) => {
  const data = event.data
  if (!data || data.type !== 'pod:message') return
  const payload = data.payload
  if (payload && payload.kind === READY_KIND) {
    lastReady = { podId: data.from, name: payload.name }
  }
}

/**
 * Answer the driver's readiness ping (relayed here via
 * `chrome.tabs.sendMessage` -> `chrome.runtime.onMessage`).
 * @returns {{ready: boolean, podId?: string, name?: string}}
 */
function statusResponse() {
  if (!lastReady) return { ready: false }
  return { ready: true, podId: lastReady.podId, name: lastReady.name }
}

/**
 * Relay a `send()` payload onto the SAME discovery channel the page's own
 * `Pod` is listening on, addressed to the pod's own `podId` -- the content
 * script acts as a one-message "peer" rather than needing any main-world
 * cooperation.
 * @param {*} payload
 */
function relayMessage(payload) {
  if (!lastReady) return
  channel.postMessage({
    type: 'pod:message',
    from: 'extension-driver',
    to: lastReady.podId,
    payload,
    ts: Date.now(),
  })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return undefined
  if (message.type === 'browser-host:status') {
    sendResponse(statusResponse())
    return undefined // synchronous response, no need to keep the channel open
  }
  if (message.type === 'browser-host:message') {
    relayMessage(message.payload)
    sendResponse({ delivered: true })
    return undefined
  }
  return undefined
})

// ---------------------------------------------------------------------------
// Inject mode: chrome.runtime port <-> window.postMessage <-> InjectedPod.
// ---------------------------------------------------------------------------

/** @type {chrome.runtime.Port|null} */
let port = null

function ensurePort() {
  if (port) return port
  port = chrome.runtime.connect({ name: 'browsermesh-pod-bridge' })
  port.onMessage.addListener((msg) => {
    // Background -> main world: forward over postMessage, tagged so the
    // main-world bootstrap's listener (and nothing else on the page) picks
    // it up.
    window.postMessage({ [BRIDGE_MARKER]: true, direction: 'to-page', msg }, '*')
  })
  port.onDisconnect.addListener(() => { port = null })
  return port
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return
  const data = event.data
  if (!data || !data[BRIDGE_MARKER] || data.direction !== 'to-extension') return
  // Main world (InjectedPod's extensionBridge.postMessage(msg)) -> background.
  ensurePort().postMessage(data.msg)
})

// Open the port eagerly so an 'inject'-mode spawn's main-world bootstrap
// has somewhere to send to as soon as it boots.
ensurePort()
