/**
 * background.mjs — the MV3 service worker (issue #185 item 7, deliverable
 * C). Boots a `Pod` representing the EXTENSION ITSELF (kind
 * `'service-worker'` — a real Chrome MV3 background service worker runs in
 * a genuine `ServiceWorkerGlobalScope`, so `detectPodKind()` classifies it
 * exactly like the one WP2's isolate-pod-host spike measured for `workerd`)
 * and runs `createExtensionDriver({chrome})`, the `PodHostDriver` that
 * actually spawns/controls the HOSTED pods (separate from this background
 * worker's own pod identity).
 *
 * CANNOT BE LOADED IN CI — see README.md. This file is real, loadable code
 * (manual "Load unpacked" instructions are in the README), but there is no
 * automated test exercising it; `test/driver.test.mjs` covers
 * `createExtensionDriver()` against a fake `chrome` instead.
 */

import { Pod } from '../../../packages/browsermesh-pod/src/index.mjs'
import { createExtensionDriver } from './driver.mjs'

/** Adjust to the real pod page's origin -- must match manifest.json's `host_permissions`. */
const POD_URL = 'https://pods.example/pod.html'

const extensionPod = new Pod()
const driver = createExtensionDriver({ chrome, podUrl: POD_URL })

/** @type {Promise<void>|null} Resolves once boot + hydrate have both run. */
let readyPromise = null

/** Boot this extension's own Pod identity and hydrate the driver's roster
 * from `chrome.storage.session` (see driver.mjs's module doc comment on
 * why: a service worker can be killed and restarted at any time). */
async function start() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await extensionPod.boot({ discoveryTimeout: 100, handshakeTimeout: 50 })
      await driver.hydrate()
    })()
  }
  return readyPromise
}

// MV3 service workers restart on demand -- `start()` runs on EVERY entry
// point a request could arrive through, not just once at module load.
chrome.runtime.onStartup?.addListener(() => { start().catch(() => {}) })
chrome.runtime.onInstalled?.addListener(() => { start().catch(() => {}) })
start().catch(() => {})

/**
 * The extension-local control surface: a popup/options page (or another
 * extension) sends `{type: 'pod-host:<verb>', ...payload}` via
 * `chrome.runtime.sendMessage`; this relays it onto `driver[verb]()`. This
 * is a convenience wrapper for manual testing, NOT the gated
 * `createPodHostService()` protocol -- wiring this driver onto a real
 * `PeerNode` (so `checkAccess()` actually gates `exec`, same as any other
 * lane) is left to whoever boots this extension pod onto a mesh, outside
 * this spike's scope.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || !message.type.startsWith('pod-host:')) return undefined
  const verb = message.type.slice('pod-host:'.length)
  if (typeof driver[verb] !== 'function') {
    sendResponse({ ok: false, error: { code: 'EINVAL', message: `unknown verb '${verb}'` } })
    return undefined
  }
  start()
    .then(() => driver[verb](...(message.args || [])))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: { code: err?.code || 'EINVAL', message: err?.message || String(err) } }))
  return true // keep the message channel open for the async sendResponse
})
