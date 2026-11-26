// Item 4 of #379: a page that only consumes must not pay for the whole apps package. The browser entry is bundled with esbuild
// (the root's dev dependency) as a bundler in a page would, and the size is asserted so it cannot grow back unnoticed.
//
// Measured when this was written (esbuild, minified, ESM, platform browser, `node:*` external):
//   the recipe before the entry existed (createMeshNode from the apps root, core, pod, connectEgress): 1,463,032 bytes
//   `@johnhenry/browsermesh-egress/browser`:                                                              267,127 bytes
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** The limit for the browser entry: about 12% over what it measured. A change that needs more says so here. */
const BROWSER_ENTRY_MAX_BYTES = 300_000

async function bundle(contents) {
  const result = await build({
    stdin: { contents, resolveDir: root, loader: 'js' },
    bundle: true, minify: true, format: 'esm', platform: 'browser', write: false, metafile: true, logLevel: 'silent',
    conditions: ['browser'], external: ['node:*'],
  })
  const [outPath] = Object.keys(result.metafile.outputs)
  const output = result.metafile.outputs[outPath]
  return { bytes: result.outputFiles[0].contents.byteLength, inputs: Object.keys(output.inputs), imports: output.imports }
}

// What a page had to write before: createMeshNode from the apps root, an identity from core, the signalling transport from pod.
const BEFORE = `
import { createMeshNode, attachService, createMeshProtocolService } from '@johnhenry/browsermesh-apps'
import { MeshIdentityManager } from '@johnhenry/browsermesh-core'
import { WebSocketTransport } from '@johnhenry/browsermesh-pod'
import { connectEgress } from '@johnhenry/browsermesh-egress'
export { createMeshNode, attachService, createMeshProtocolService, MeshIdentityManager, WebSocketTransport, connectEgress }
`
const AFTER = `
import { createEgressNode, connectEgress } from './src/browser.mjs'
export { createEgressNode, connectEgress }
`

describe('what a page that only consumes pulls in', () => {
  it('the browser entry bundles under its bound, and to a fraction of the old recipe', async () => {
    const before = await bundle(BEFORE)
    const after = await bundle(AFTER)
    console.log(`bundle sizes (minified): old recipe ${before.bytes} bytes, browser entry ${after.bytes} bytes`)
    assert.ok(after.bytes <= BROWSER_ENTRY_MAX_BYTES, `the browser entry is ${after.bytes} bytes; the bound is ${BROWSER_ENTRY_MAX_BYTES}`)
    assert.ok(after.bytes < before.bytes / 4, `the browser entry (${after.bytes}) is not under a quarter of the old recipe (${before.bytes})`)
  })

  it('and none of the services, the wsh client or a node: import is in it', async () => {
    const after = await bundle(AFTER)
    const heavy = ['orchestrator.mjs', 'marketplace.mjs', 'peer-routing.mjs', 'mesh-swarm.mjs', 'mesh-bootstrap.mjs', 'wsh-negotiator.mjs', 'payments.mjs', '/wsh/']
    for (const name of heavy) assert.ok(!after.inputs.some((i) => i.includes(name)), `${name} is in the browser bundle`)
    assert.deepEqual(after.imports.filter((i) => i.external), [], 'the bundle imports nothing it did not include (no node: module)')
    assert.ok(!after.inputs.some((i) => /\/(provider|node|node-exchange|limits)\.mjs$/.test(i) && i.includes('browsermesh-egress')), 'no provider file is in it')
  })

  it('is its own subpath export of the package, typed, and the main entry is as it was', async () => {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    assert.deepEqual(pkg.exports['./browser'], { types: './src/browser.d.ts', default: './src/browser.mjs' })
    assert.deepEqual(pkg.exports['.'], { types: './src/index.d.ts', default: './src/index.mjs' })
    assert.equal(pkg.sideEffects, false)
    await readFile(path.join(root, 'src/browser.d.ts'), 'utf8')
  })
})
