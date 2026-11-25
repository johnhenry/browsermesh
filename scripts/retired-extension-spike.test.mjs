// The MV3 extension spike was retired (#272, decision 3 of docs/design/hosted-pods-open-decisions.md):
// it never ran in a real Chromium (its service worker imported a file outside the extension root).
// What was learned is in docs/hosted-pods.md. Nothing may still point at the removed directory or
// its driver, so a reader is never sent to a path that does not exist.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// Built from pieces so this file does not match itself.
const DIR_NAME = ['browser', 'extension', 'host'].join('-')
const DRIVER_NAME = ['create', 'Extension', 'Driver'].join('')
const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'dist', 'coverage'])
// Release history is generated and keeps describing what was published at the time.
const SKIP_FILES = new Set(['CHANGELOG.md'])

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (!SKIP_FILES.has(entry.name)) yield path
  }
}

describe('the retired MV3 extension spike', () => {
  it('the spike directory is gone', async () => {
    await assert.rejects(access(join(ROOT, 'spikes', DIR_NAME)), { code: 'ENOENT' })
  })

  it('no text file in the repository names its directory or its driver', async () => {
    const offenders = []
    for await (const file of walk(ROOT)) {
      if (!/\.(m?js|cjs|ts|json|md|ya?ml|sh)$/.test(file)) continue
      const text = await readFile(file, 'utf8')
      if (text.includes(DIR_NAME) || text.includes(DRIVER_NAME)) offenders.push(file.slice(ROOT.length))
    }
    assert.deepEqual(offenders, [], 'a reference to the removed spike is a dead link')
  })

  it('docs/hosted-pods.md records why it did not run and what a working one would need', async () => {
    const text = await readFile(join(ROOT, 'docs', 'hosted-pods.md'), 'utf8')
    assert.match(text, /### What was learned from the MV3 extension spike/)
    assert.match(text, /outside the extension root/i)
    assert.match(text, /bundl/i)
  })
})
