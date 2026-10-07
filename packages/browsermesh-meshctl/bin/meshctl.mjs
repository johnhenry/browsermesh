#!/usr/bin/env node
/**
 * bin/meshctl.mjs — the thin wrapper `package.json`'s `bin.meshctl` points
 * at. All behavior lives in `../src/cli.mjs`'s `main()`, which is
 * importable on its own so `test/helpers.mjs`'s `runCli()` can invoke it
 * in-process rather than forking a process per test.
 *
 * SIGINT is wired to an `AbortController` and handed to `main()` as
 * `io.signal`, which is what lets `watch` end its NDJSON stream cleanly
 * (one final summary document, then a normal exit) instead of being
 * killed mid-write.
 */

// Node >= 25 emits an ExperimentalWarning the first time anything touches
// `globalThis.localStorage` (a transitive browser-compat probe in the mesh
// stack). It is noise on a JSON-first CLI's stderr, so filter exactly that
// one warning and let every other warning through untouched.
const defaultWarningListeners = process.listeners('warning')
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning?.name === 'ExperimentalWarning' && /localStorage/.test(String(warning.message))) return
  for (const listener of defaultWarningListeners) listener(warning)
})

import { main } from '../src/cli.mjs'

const controller = new AbortController()
process.once('SIGINT', () => controller.abort())

const code = await main(process.argv.slice(2), { signal: controller.signal })
process.exitCode = code
