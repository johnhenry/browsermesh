// `npm test` must let every package finish. turbo's default stops the run at the first failing package and terminates the
// ones still running; node:test reports each terminated test file as "Promise resolution is still pending but the event loop
// has already resolved", so one real failure showed up as dozens of file-level failures with the real one buried
// among them (#449). With --continue each package reports its own result and the one real failure is the only one.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))

describe('the root test script', () => {
  it('runs every package to completion (turbo --continue) so a failure cannot cancel its siblings', () => {
    const turbo = pkg.scripts.test.split('&&').map((s) => s.trim()).find((s) => s.startsWith('turbo run test'))
    assert.ok(turbo, 'the root test script runs turbo')
    assert.match(turbo, /(^|\s)--continue(\s|=|$)/)
  })
})
