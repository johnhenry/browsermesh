import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const execFileAsync = promisify(execFile)
const binPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'meshctl.mjs')

describe('bin/meshctl.mjs (real subprocess)', () => {
  it('node bin/meshctl.mjs --help exits 0 and prints a JSON document', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binPath, '--help'])
    const doc = JSON.parse(stdout)
    assert.equal(doc.ok, true)
    assert.equal(doc.result.name, 'meshctl')
    // The only expected stderr content is Node's own experimental-feature
    // warning banner (localStorage, in this Node version) -- never meshctl
    // output, which always stays on its own streams per command.
    assert.doesNotMatch(stderr, /"ok"\s*:/)
  })

  it('node bin/meshctl.mjs (no args) exits 0 with the usage document', async () => {
    const { stdout } = await execFileAsync(process.execPath, [binPath])
    const doc = JSON.parse(stdout)
    assert.equal(doc.ok, true)
    assert.ok(Array.isArray(doc.result.commands))
  })

  it('an unknown command exits 2', async () => {
    await assert.rejects(
      execFileAsync(process.execPath, [binPath, 'bogus']),
      (err) => {
        assert.equal(err.code, 2)
        // Node's own experimental-feature warning banner may also land on
        // stderr ahead of meshctl's own output; meshctl's JSON document is
        // always the line starting with '{'.
        const jsonLine = err.stderr.split('\n').find((line) => line.startsWith('{'))
        const doc = JSON.parse(jsonLine)
        assert.equal(doc.error.code, 'EUSAGE')
        return true
      },
    )
  })
})
