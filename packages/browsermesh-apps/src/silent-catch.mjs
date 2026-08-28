/**
 * silent-catch.mjs — debug-gated structured logger for the
 * `try { … } catch { /* ignore *\/ }` pattern.
 *
 * Vendored from clawser-silent-catch.mjs (fully standalone, no other
 * clawser-app imports) so this package doesn't need to reach into web/.
 *
 * Replaces silent catches with an opt-in inspectable record. Default
 * behaviour is unchanged (silent), so this is a drop-in replacement.
 * Users surface the events by enabling debug mode:
 *
 *   localStorage.setItem('clawser_debug', 'true')   // persistent
 *   // or, in DevTools:  clawserDebug.enable()
 */

let enabled = false;
try {
  if (typeof localStorage !== 'undefined') {
    enabled = localStorage.getItem('clawser_debug') === 'true';
  }
} catch {
  // localStorage may throw in privacy / sandbox contexts — treat as disabled
}

/** Re-check the localStorage flag; called by clawserDebug.enable/disable. */
export function refreshSilentCatchState() {
  try {
    if (typeof localStorage !== 'undefined') {
      enabled = localStorage.getItem('clawser_debug') === 'true';
    }
  } catch {
    enabled = false;
  }
}

/**
 * Log a silent-catch event. No-op unless debug mode is enabled.
 *
 * @param {string} module     — file/component (e.g. 'clawser-pod')
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
  console.warn('[clawser:silent-catch]', entry);
}
