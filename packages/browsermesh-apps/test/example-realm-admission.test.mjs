// Run with: node --import ./test/_setup-globals.mjs --test test/example-realm-admission.test.mjs
//
// CI runs `npm test`, not `npm run examples`, so this is what keeps examples/26-realm-admission.mjs from rotting: it
// runs the example and requires it to finish and print each step. It lives here (not in the realm package) because the
// example needs the real PeerRegistry and admission seam, and the realm package never depends on apps.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const example = fileURLToPath(new URL('../../../examples/26-realm-admission.mjs', import.meta.url))

describe('examples/26-realm-admission.mjs', () => {
  it('runs to completion, showing every admission outcome and the audit summary', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [example], { timeout: 60_000 })
    for (const line of [
      'REFUSED  stranger without a credential',
      'ALLOWED  stranger with a credential for its pod id',
      'dropped by host policy: egress:tcp:example.com:443:connect',
      'REFUSED  credential for a different pod id (subject-mismatch)',
      'ALLOWED  open-mode guest',
      'REFUSED  old credential after the epoch bump (epoch-too-old)',
      'audit: granted=',
      'ok: ',
    ]) assert.ok(stdout.includes(line), `missing: ${line}\n${stdout}`)
  })
})
