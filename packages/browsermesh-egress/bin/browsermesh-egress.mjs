#!/usr/bin/env node
import { main } from '../src/cli/run.mjs'

// `main` resolves with an exit code when it ends (bad input, `--help`, `--dry-run`) and with `null` once the provider is
// serving: the open mesh node then keeps the process alive until a signal ends it.
const code = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr })
if (code !== null) process.exit(code)
