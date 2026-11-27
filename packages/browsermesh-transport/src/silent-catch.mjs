/**
 * silent-catch.mjs — debug-gated structured logger for the
 * `try { … } catch { /* ignore *\/ }` pattern.
 *
 * Standalone (no other imports) so this package is self-contained.
 *
 * Replaces silent catches with an opt-in inspectable record. Default
 * behaviour is unchanged (silent), so this is a drop-in replacement.
 * Users surface the events by enabling debug mode:
 *
 *   localStorage.setItem('browsermesh_debug', 'true')   // persistent
 *   // or, in DevTools:  browsermeshDebug.enable()
 */

/** Primary localStorage key. */
const DEBUG_KEY = 'browsermesh_debug';
/** Deprecated alias, kept for compatibility. */
const LEGACY_DEBUG_KEY = 'clawser_debug';

/**
 * Find `localStorage` without tripping Node's getter.
 *
 * Since Node 25 the global `localStorage` is an accessor that prints
 * "ExperimentalWarning: localStorage is not available because
 * --localstorage-file was not provided" the moment it is read (even by
 * `typeof localStorage`). So the descriptor is inspected first:
 *   - no property: nothing to read;
 *   - a data property (a test polyfill, a plain value): use it;
 *   - an accessor in Node: read it only when `--localstorage-file` was given
 *     (execArgv or NODE_OPTIONS), where the getter returns a real Storage;
 *   - an accessor anywhere else (browsers, Deno): call it, as before.
 */
function getStorage() {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (!desc) return undefined;
  if ('value' in desc) return desc.value;
  const proc = globalThis.process;
  if (proc?.versions?.node && typeof document === 'undefined') {
    const hasFile = (proc.execArgv ?? []).some((a) => a === '--localstorage-file' || a.startsWith('--localstorage-file='))
      || /(^|\s)--localstorage-file(\s|=|$)/.test(proc.env?.NODE_OPTIONS ?? '');
    if (!hasFile) return undefined;
  }
  return desc.get ? desc.get.call(globalThis) : undefined;
}

function readFlag() {
  const storage = getStorage();
  if (!storage) return false;
  return storage.getItem(DEBUG_KEY) === 'true'
    || storage.getItem(LEGACY_DEBUG_KEY) === 'true';
}

let enabled = false;
try {
  enabled = readFlag();
} catch {
  // localStorage may throw in privacy / sandbox contexts — treat as disabled
}

/** Re-check the localStorage flag; called by browsermeshDebug.enable/disable. */
export function refreshSilentCatchState() {
  try {
    enabled = readFlag();
  } catch {
    enabled = false;
  }
}

const debugApi = {
  enable() {
    try { getStorage()?.setItem(DEBUG_KEY, 'true'); } catch { /* ignore */ }
    refreshSilentCatchState();
  },
  disable() {
    try {
      const storage = getStorage();
      storage?.removeItem(DEBUG_KEY);
      storage?.removeItem(LEGACY_DEBUG_KEY);
    } catch { /* ignore */ }
    refreshSilentCatchState();
  },
};

if (typeof globalThis !== 'undefined') {
  if (!globalThis.browsermeshDebug) globalThis.browsermeshDebug = debugApi;
  /** Deprecated alias for `browsermeshDebug`, kept for compatibility. */
  if (!globalThis.clawserDebug) globalThis.clawserDebug = globalThis.browsermeshDebug;
}

/**
 * Log a silent-catch event. No-op unless debug mode is enabled.
 *
 * @param {string} module     — file/component (e.g. 'webrtc')
 * @param {string} operation  — what was attempted (e.g. 'relay-disconnect')
 * @param {*}      error      — the caught value
 * @param {object} [context]  — extra structured fields
 */
export function silentCatch(module, operation, error, context) {
  // Re-read the flag each call so toggles in DevTools take effect without
  // restart. Cheap (one localStorage hit per silent catch in debug mode;
  // catches happen rarely on hot paths).
  if (!enabled) {
    refreshSilentCatchState();
    if (!enabled) return;
  }
  const entry = { module, operation, error: error?.message || String(error) };
  if (context) Object.assign(entry, context);
  console.warn('[browsermesh:silent-catch]', entry);
}
