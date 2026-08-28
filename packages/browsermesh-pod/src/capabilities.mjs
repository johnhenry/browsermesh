/**
 * capabilities.mjs — Detect available browser/runtime capabilities.
 *
 * Returns a PodCapabilities object describing what messaging, network,
 * storage, and compute primitives are available in the current context.
 */

/**
 * @typedef {object} PodCapabilities
 * @property {object} messaging
 * @property {boolean} messaging.postMessage
 * @property {boolean} messaging.messageChannel
 * @property {boolean} messaging.broadcastChannel
 * @property {boolean} messaging.sharedWorker
 * @property {boolean} messaging.serviceWorker
 * @property {object} network
 * @property {boolean} network.fetch
 * @property {boolean} network.webSocket
 * @property {boolean} network.webTransport
 * @property {boolean} network.webRTC
 * @property {object} storage
 * @property {boolean} storage.indexedDB
 * @property {boolean} storage.cacheAPI
 * @property {boolean} storage.opfs
 * @property {object} compute
 * @property {boolean} compute.wasm
 * @property {boolean} compute.sharedArrayBuffer
 * @property {boolean} compute.offscreenCanvas
 */

/**
 * Detect capabilities available in the current execution context.
 *
 * @param {object} [g=globalThis] - The global scope to inspect
 * @returns {PodCapabilities}
 */
export function detectCapabilities(g = globalThis) {
  return {
    messaging: {
      postMessage: typeof g.postMessage === 'function',
      messageChannel: typeof g.MessageChannel === 'function',
      broadcastChannel: typeof g.BroadcastChannel === 'function',
      sharedWorker: typeof g.SharedWorker === 'function',
      serviceWorker: !!(g.navigator && g.navigator.serviceWorker),
    },
    network: {
      fetch: typeof g.fetch === 'function',
      webSocket: typeof g.WebSocket === 'function',
      webTransport: typeof g.WebTransport === 'function',
      webRTC: typeof g.RTCPeerConnection === 'function',
    },
    storage: {
      indexedDB: typeof g.indexedDB !== 'undefined',
      cacheAPI: typeof g.caches !== 'undefined',
      opfs: !!(g.navigator && g.navigator.storage && typeof g.navigator.storage.getDirectory === 'function'),
    },
    compute: {
      wasm: typeof g.WebAssembly !== 'undefined',
      sharedArrayBuffer: typeof g.SharedArrayBuffer === 'function',
      offscreenCanvas: typeof g.OffscreenCanvas === 'function',
    },
  }
}
