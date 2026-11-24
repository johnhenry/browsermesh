#!/usr/bin/env node
import { main } from '../src/cli/run.mjs'

// `main` resolves with an exit code when it ends (bad input, `--help`) and with `null` once the listener is up:
// the open server then keeps the process alive until a signal ends it.
const code = await main(process.argv.slice(2), { env: process.env, stdout: process.stdout, stderr: process.stderr })
if (code !== null) process.exit(code)
