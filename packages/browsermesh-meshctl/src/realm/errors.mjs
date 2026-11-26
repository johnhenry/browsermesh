/**
 * realm/errors.mjs -- the stable error codes of `meshctl realm ...`.
 *
 * | code                        | exit | meaning |
 * | --------------------------- | ---- | ------- |
 * | EUSAGE                      | 2    | bad argv, a missing passphrase option, a missing optional package |
 * | EREALM_NOT_IMPLEMENTED      | 2    | `realm invite`: tickets and admitters are not in v1 |
 * | EREALM_AMBIGUOUS            | 2    | a realm reference matches several realms |
 * | EREALM_BAD_PASSPHRASE       | 3    | the passphrase does not open the sealed key |
 * | EREALM_PASSPHRASE_FILE_MODE | 3    | `--passphrase-file` is readable by someone else |
 * | EREALM_NO_KEY               | 3    | this machine does not hold the key the command must sign with |
 * | EREALM_NOT_FOUND            | 4    | no such realm in the store |
 * | ENOENT                      | 4    | a file or serial that is not there |
 * | EREALM_VERIFY               | 1    | a descriptor or credential does not verify |
 * | EREALM_EXISTS               | 1    | the realm is already in the store |
 * | EREALM_CORRUPT              | 1    | a stored file is not what it should be |
 */
import { UsageError } from '../output.mjs'

export { UsageError }

export class RealmCliError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'RealmCliError'
    this.code = code
  }
}

/**
 * Run `fn`; a typed `RealmError` from the realm package (bad caller input to a builder) becomes a usage error that
 * carries the package's own reason code.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function building(fn) {
  try {
    return await fn()
  } catch (err) {
    if (err?.name === 'RealmError') throw new UsageError(`${err.code}: ${err.message}`)
    throw err
  }
}

/** A verifier verdict that is not ok, as an error. */
export function verifyError(what, verdict) {
  const extra = verdict.detail && verdict.detail !== verdict.reason ? ` (${verdict.detail})` : ''
  return new RealmCliError('EREALM_VERIFY', `${what} does not verify: ${verdict.reason}${extra}`)
}
