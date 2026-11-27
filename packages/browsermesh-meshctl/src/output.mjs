/**
 * output.mjs — the JSON-first output contract every `meshctl` command shares
 * (issue #185 item 5).
 *
 * Every command prints exactly ONE JSON document to stdout: pretty-printed
 * when stdout is a TTY, compact otherwise, with `--json`/`--pretty`
 * overriding the auto-detection either way. Errors are a JSON document on
 * STDERR shaped `{ ok: false, error: { code, message } }`, paired with an
 * exit code from `EXIT_CODE` -- never a bare stack trace, so a script piping
 * `meshctl`'s output never has to guess whether what it just parsed was the
 * result or a crash.
 *
 * The one deliberate exception is `watch`, which streams NDJSON (one JSON
 * object per line, no pretty-printing) until SIGINT -- see `commands.mjs`'s
 * `watch` handler, which writes directly rather than going through
 * `printResult()`.
 */

/**
 * Exit codes `meshctl` uses, matching the issue #185 item 5 design doc.
 * `ELANE` and `ENOTSUP` (`host-protocol.mjs`'s `POD_HOST_ERROR`) share exit
 * code 5: both mean "this verb cannot be served here", just for different
 * reasons (structural vs. driver gap), and a shell script branching on exit
 * code has no use for the distinction `error.code` already carries.
 */
export const EXIT_CODE = Object.freeze({
  OK: 0,
  GENERIC: 1,
  USAGE: 2,
  EACCES: 3,
  ENOENT: 4,
  ELANE: 5,
  ETIMEDOUT: 6,
})

/** `POD_HOST_ERROR` (and `EUSAGE`) code -> `EXIT_CODE` value. */
const ERROR_CODE_TO_EXIT = Object.freeze({
  EUSAGE: EXIT_CODE.USAGE,
  EACCES: EXIT_CODE.EACCES,
  // The host did not allow this identity to open a (wsh) link to it: the same
  // answer as a verb it did not grant.
  WSH_REFUSED: EXIT_CODE.EACCES,
  ENOENT: EXIT_CODE.ENOENT,
  ELANE: EXIT_CODE.ELANE,
  ENOTSUP: EXIT_CODE.ELANE,
  ETIMEDOUT: EXIT_CODE.ETIMEDOUT,
  // `meshctl realm ...` (see `realm/errors.mjs`): stable codes, mapped onto the same table.
  EREALM_NOT_IMPLEMENTED: EXIT_CODE.USAGE,
  EREALM_AMBIGUOUS: EXIT_CODE.USAGE,
  // A passphrase that does not open the key, a passphrase file others can read, a key this machine does not hold.
  EREALM_BAD_PASSPHRASE: EXIT_CODE.EACCES,
  EREALM_PASSPHRASE_FILE_MODE: EXIT_CODE.EACCES,
  EREALM_NO_KEY: EXIT_CODE.EACCES,
  EREALM_NOT_FOUND: EXIT_CODE.ENOENT,
  // EREALM_VERIFY, EREALM_EXISTS and EREALM_CORRUPT fall through to GENERIC.
})

/**
 * @param {string} [code] - A `POD_HOST_ERROR` value, `'EUSAGE'`, or anything else.
 * @returns {number} An `EXIT_CODE` value; unknown/missing codes map to `GENERIC`.
 */
export function exitCodeForError(code) {
  return ERROR_CODE_TO_EXIT[code] ?? EXIT_CODE.GENERIC
}

/**
 * The exit code of `meshctl hosts`, which prints one entry per host (a failed host carries its own `error`) and so always
 * prints an `ok` document. Exit 0 when at least one host answered; when EVERY listed host failed, the code they share
 * (3 if all were refusals, 6 if all timed out, ...), or `GENERIC` when they failed in different ways. No hosts at all is
 * not a failure here (the command is a usage error before it gets this far).
 * @param {unknown} entries - `cmdHosts`'s result.
 * @returns {number} An `EXIT_CODE` value.
 */
export function exitCodeForHosts(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return EXIT_CODE.OK
  if (!entries.every((entry) => entry && entry.error)) return EXIT_CODE.OK
  const codes = new Set(entries.map((entry) => exitCodeForError(entry.error.code)))
  return codes.size === 1 ? [...codes][0] : EXIT_CODE.GENERIC
}

/** Thrown for bad argv -- caught by `cli.mjs` and reported as exit 2. */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'UsageError'
    this.code = 'EUSAGE'
  }
}

/**
 * Resolve the effective formatting mode from CLI flags and the stream
 * `meshctl` is writing to.
 *
 * @param {object} opts
 * @param {boolean} [opts.json] - `--json`: force compact.
 * @param {boolean} [opts.pretty] - `--pretty`: force pretty.
 * @param {{isTTY?: boolean}} [opts.stream] - Defaults to `process.stdout`.
 * @returns {{pretty: boolean}}
 */
export function resolveFormat({ json, pretty, stream } = {}) {
  if (json) return { pretty: false }
  if (pretty) return { pretty: true }
  return { pretty: Boolean((stream || process.stdout).isTTY) }
}

/**
 * Serialize one JSON document per the resolved format.
 *
 * @param {*} doc
 * @param {{pretty: boolean}} format
 * @returns {string} Without a trailing newline -- callers add one.
 */
export function formatDocument(doc, format) {
  return format.pretty ? JSON.stringify(doc, null, 2) : JSON.stringify(doc)
}

/**
 * @param {*} result - The command's result value, JSON-serializable.
 * @returns {{ok: true, result: *}}
 */
export function okEnvelope(result) {
  return { ok: true, result }
}

/**
 * @param {{code?: string, message?: string}|Error} err
 * @returns {{ok: false, error: {code: string, message: string}}}
 */
export function errorEnvelope(err) {
  const code = (err && typeof err.code === 'string' && err.code) || 'EUNKNOWN'
  const message = (err && typeof err.message === 'string' && err.message) || String(err)
  return { ok: false, error: { code, message } }
}

/**
 * A quiet-aware stderr logger (diagnostics only -- never part of the one
 * stdout JSON document).
 *
 * @param {object} opts
 * @param {boolean} [opts.quiet]
 * @param {{write: Function}} [opts.stream] - Defaults to `process.stderr`.
 * @returns {(msg: string) => void}
 */
export function createLogger({ quiet, stream } = {}) {
  const out = stream || process.stderr
  if (quiet) return () => {}
  return (msg) => { out.write(`${msg}\n`) }
}
