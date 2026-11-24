import { test, expect } from './fixtures.mjs'

// The repository's examples, unmodified, in a real page. They import
// `node:assert/strict`, which the import map points at a small shim.
// (Their own simulated transports stay simulated: this proves the code runs
// in a browser under the strict policy, not a real network.)
const EXAMPLES = [
  ['01-identity-and-signed-messages.mjs', /^ok: identity generation/],
  ['02-two-pods-discover-and-message.mjs', /^ok: two independently-booted Pods/],
  ['05-crdt-sync-across-two-engines.mjs', /^ok: two independent engines converged/],
]

for (const [file, done] of EXAMPLES) {
  test(`example ${file} runs in the browser`, async ({ servers, open }) => {
    const page = await open(servers.a)
    const lines = []
    page.on('console', (msg) => lines.push(msg.text()))
    await page.evaluate((f) => window.bm.runExample(f), file)
    // The example's own assertions passed (they throw otherwise) and it reached its final line.
    expect(lines.filter((l) => done.test(l))).toHaveLength(1)
  })
}
