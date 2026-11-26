// Every package ships the same MIT text, holder and year as the root LICENSE, so a copied or new package cannot drift.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const root = await readFile(join(ROOT, 'LICENSE'), 'utf8')
const packages = (await readdir(join(ROOT, 'packages'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)

describe('LICENSE files', () => {
  it('the root names John Henry', () => {
    assert.match(root, /^Copyright \(c\) 2026 John Henry$/m)
  })

  for (const name of packages) {
    it(`packages/${name}/LICENSE is identical to the root`, async () => {
      const text = await readFile(join(ROOT, 'packages', name, 'LICENSE'), 'utf8')
      assert.equal(text, root)
    })
  }
})
