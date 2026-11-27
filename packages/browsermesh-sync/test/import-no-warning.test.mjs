// Importing the package must not touch Node's `localStorage` getter, which
// prints "ExperimentalWarning: localStorage is not available because
// --localstorage-file was not provided" on stderr.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = fileURLToPath(new URL('..', import.meta.url))
const silentCatchUrl = new URL('../src/silent-catch.mjs', import.meta.url).href

const run = (args) => new Promise((resolve) => {
  // A clean environment for the child: no polyfill preload, no inherited NODE_OPTIONS.
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  execFile(process.execPath, args, { cwd: pkgDir, env }, (error, stdout, stderr) => {
    resolve({ code: error ? error.code : 0, stdout, stderr })
  })
})

describe('importing @johnhenry/browsermesh-sync', () => {
  it('exits 0 and prints nothing on stderr', async () => {
    const r = await run(['--input-type=module', '-e', "await import('@johnhenry/browsermesh-sync')"])
    assert.equal(r.stderr, '')
    assert.equal(r.code, 0)
  })

  it('debug stays off, silently, when there is no storage', async () => {
    const script = `
      const { silentCatch } = await import(${JSON.stringify(silentCatchUrl)})
      const warns = []
      console.warn = (...a) => warns.push(a)
      silentCatch('m', 'op', new Error('x'))
      console.log(JSON.stringify({ warns: warns.length }))
    `
    const r = await run(['--input-type=module', '-e', script])
    assert.equal(r.stderr, '')
    assert.deepEqual(JSON.parse(r.stdout), { warns: 0 })
  })

  it('with --localstorage-file the debug flag still works, and stderr is still clean', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bm-sync-ls-'))
    try {
      const script = `
        localStorage.setItem('browsermesh_debug', 'true')
        const { silentCatch } = await import(${JSON.stringify(silentCatchUrl)})
        await import('@johnhenry/browsermesh-sync')
        const warns = []
        console.warn = (...a) => warns.push(a)
        silentCatch('m', 'op', new Error('x'))
        console.log(JSON.stringify({ warns: warns.length }))
      `
      const r = await run([`--localstorage-file=${join(dir, 'ls.db')}`, '--input-type=module', '-e', script])
      assert.equal(r.stderr, '')
      assert.deepEqual(JSON.parse(r.stdout), { warns: 1 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('still honours a data-property localStorage polyfill', async () => {
    const script = `
      Object.defineProperty(globalThis, 'localStorage', {
        value: { getItem: (k) => (k === 'browsermesh_debug' ? 'true' : null), setItem() {}, removeItem() {} },
        configurable: true, writable: true,
      })
      const { silentCatch } = await import(${JSON.stringify(silentCatchUrl)})
      const warns = []
      console.warn = (...a) => warns.push(a)
      silentCatch('m', 'op', new Error('x'))
      console.log(JSON.stringify({ warns: warns.length }))
    `
    const r = await run(['--input-type=module', '-e', script])
    assert.equal(r.stderr, '')
    assert.deepEqual(JSON.parse(r.stdout), { warns: 1 })
  })
})
