// CI runs `npm test`, not `npm run examples`, so this is what keeps
// examples/25-meshctl-through-a-relay.mjs from rotting: it runs the example and
// requires it to finish, exit 0 and print its allowed, refused and closing lines.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const example = fileURLToPath(new URL('../../../examples/25-meshctl-through-a-relay.mjs', import.meta.url))

describe('examples/25-meshctl-through-a-relay.mjs', () => {
  it('runs to completion and prints its allowed, refused and closing lines', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [example], { timeout: 60_000 })
    for (const step of ['ALLOWED', 'REFUSED', 'WSH_REFUSED', 'ok: ']) {
      assert.ok(stdout.includes(step), `missing: ${step}`)
    }
  })
})
