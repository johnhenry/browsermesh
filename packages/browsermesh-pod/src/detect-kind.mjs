/**
 * detect-kind.mjs — Classify the current execution context.
 *
 * Inspects globalThis to determine what kind of browser (or non-browser)
 * environment this code is running in. Returns one of 8 pod kinds.
 */

/** @typedef {'service-worker'|'shared-worker'|'worker'|'worklet'|'server'|'iframe'|'spawned'|'window'} PodKind */

/**
 * Detect the pod kind for the current execution context.
 *
 * @param {object} [g=globalThis] - The global scope to inspect
 * @returns {PodKind}
 */
export function detectPodKind(g = globalThis) {
  // Service worker (extends WorkerGlobalScope, check first)
  if (typeof g.ServiceWorkerGlobalScope !== 'undefined' && g instanceof g.ServiceWorkerGlobalScope) {
    return 'service-worker'
  }

  // Shared worker
  if (typeof g.SharedWorkerGlobalScope !== 'undefined' && g instanceof g.SharedWorkerGlobalScope) {
    return 'shared-worker'
  }

  // Dedicated worker (generic WorkerGlobalScope — after SW/SharedWorker checks)
  if (typeof g.WorkerGlobalScope !== 'undefined' && g instanceof g.WorkerGlobalScope) {
    return 'worker'
  }

  // Audio worklet
  if (typeof g.AudioWorkletGlobalScope !== 'undefined' && g instanceof g.AudioWorkletGlobalScope) {
    return 'worklet'
  }

  // No window or document → server / Node.js / Deno
  if (typeof g.window === 'undefined' || typeof g.document === 'undefined') {
    return 'server'
  }

  // Window exists — check framing
  try {
    if (g.window !== g.window.parent) return 'iframe'
  } catch {
    // Cross-origin parent access throws — must be an iframe
    return 'iframe'
  }

  // Spawned window (window.open)
  if (g.window.opener) return 'spawned'

  // Default: top-level window
  return 'window'
}
