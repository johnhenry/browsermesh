// The remote-eval spike (spikes/browser-extension-host) is frozen (#272): its `exec`
// evaluates code and cannot work under a strict CSP. It is kept as a record, so:
//   - nothing under packages/ may import it, and
//   - its README and entry files keep saying it is frozen and what replaces it.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SPIKE = join(ROOT, 'spikes', 'browser-extension-host')

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.turbo') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}

describe('the frozen remote-eval spike', () => {
  it('nothing under packages/ imports it or depends on it (a comment that mentions it is fine)', async () => {
    const offenders = []
    const importsIt = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"][^'"]*browser-extension-host/
    const dependsOnIt = /"browser-extension-host-spike"\s*:/
    for await (const file of walk(join(ROOT, 'packages'))) {
      if (!/\.(m?js|cjs|ts|json)$/.test(file)) continue
      const text = await readFile(file, 'utf8')
      if (importsIt.test(text) || (file.endsWith('package.json') && dependsOnIt.test(text))) offenders.push(file.slice(ROOT.length))
    }
    assert.deepEqual(offenders, [], 'a published package must not depend on a frozen spike')
  })

  it('the root workspaces do not include it', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
    assert.deepEqual(pkg.workspaces, ['packages/*'])
    assert.equal(JSON.parse(await readFile(join(SPIKE, 'package.json'), 'utf8')).private, true)
  })

  it('its README and entry files say it is frozen and point at what replaces it', async () => {
    for (const file of ['README.md', 'src/background.mjs', 'src/driver.mjs']) {
      const head = (await readFile(join(SPIKE, file), 'utf8')).slice(0, 2500)
      assert.match(head, /FROZEN/, `${file} starts with the frozen notice`)
      assert.match(head, /wsh\/objects/, `${file} names the replacement`)
      assert.match(head, /examples\/19/, `${file} points at the example`)
    }
  })
})
