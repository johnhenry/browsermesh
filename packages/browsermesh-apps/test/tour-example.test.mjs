// CI runs `npm test`, not `npm run examples`, so this is what keeps examples/28-tour.mjs from rotting: it runs the
// tour and requires it to exit 0 and to print one allowed and one refused line for every leg, the audit and the closing line.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const example = fileURLToPath(new URL('../../../examples/28-tour.mjs', import.meta.url))

describe('examples/28-tour.mjs', () => {
  it('runs to completion and prints an ALLOWED and a REFUSED line for every leg, then the audit', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [example], { timeout: 60_000 })
    for (const leg of ['ingress', 'egress', 'mcp', 'objects', 'realm', 'meshctl']) {
      assert.match(stdout, new RegExp(`ALLOWED +\\[${leg}\\]`), `no ALLOWED line for ${leg}`)
      assert.match(stdout, new RegExp(`REFUSED +\\[${leg}\\]`), `no REFUSED line for ${leg}`)
    }
    assert.match(stdout, /audit: ingress/)
    assert.match(stdout, /audit: egress/)
    assert.match(stdout, /audit: registry/)
    assert.match(stdout, /ok: /)
  })
})
