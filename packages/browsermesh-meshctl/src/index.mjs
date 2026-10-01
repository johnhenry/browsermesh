/**
 * index.mjs — `@johnhenry/browsermesh-meshctl`'s barrel export.
 *
 * `meshctl` is primarily a CLI (`bin/meshctl.mjs`), but every piece behind
 * it is a plain, importable module -- `main()` itself (what `bin/
 * meshctl.mjs` and `test/helpers.mjs`'s `runCli()` both call), the
 * identity/connection builders, and the command handlers. Re-exported here
 * so `import { main } from '@johnhenry/browsermesh-meshctl'` works for
 * anything embedding `meshctl` without going through a child process.
 */

export { main } from './cli.mjs'
export { parseCommand, tokenize } from './args.mjs'
export { DEFAULT_IDENTITY_PATH, DEFAULT_IDENTITY_LABEL, loadOrCreateIdentity } from './identity.mjs'
export { connect } from './connect.mjs'
export { createLoopbackSession, DEFAULT_LOOPBACK_HOSTS } from './loopback.mjs'
export { createRealMeshSession } from './real-mesh.mjs'
export { selectAutoHost } from './auto-placement.mjs'
export { runVmCommand, VM_COMMANDS } from './vm-bridge.mjs'
export {
  EXIT_CODE, UsageError, exitCodeForError, resolveFormat, formatDocument, okEnvelope, errorEnvelope, createLogger,
} from './output.mjs'
