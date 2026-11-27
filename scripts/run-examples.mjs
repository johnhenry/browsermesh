/**
 * run-examples.mjs -- `npm run examples`: run every example in order, stop at
 * the first one that fails, and give each a time limit so a hung example fails
 * the run instead of stalling it. The examples are `examples/NN-*.mjs`, then
 * each `packages/<name>/examples/*.mjs` (examples/README.md lists them).
 *
 *   node scripts/run-examples.mjs            run all, 60 s each
 *   EXAMPLE_TIMEOUT_MS=120000 node scripts/run-examples.mjs
 */
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TIMEOUT_MS = Number(process.env.EXAMPLE_TIMEOUT_MS) || 60_000

async function jsFiles(dir, pattern) {
  let names
  try { names = await readdir(join(ROOT, dir)) } catch { return [] }
  return names.filter((n) => pattern.test(n)).sort().map((n) => join(dir, n))
}

export async function listExamples() {
  const files = await jsFiles('examples', /^\d\d-.*\.mjs$/)
  const packages = (await readdir(join(ROOT, 'packages'), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  for (const name of packages) files.push(...await jsFiles(join('packages', name, 'examples'), /\.mjs$/))
  return files
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: ROOT, stdio: 'inherit' })
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ ok: false, why: `timed out after ${TIMEOUT_MS} ms` }) }, TIMEOUT_MS)
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, why: err.message }) })
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, why: `exited with ${code ?? signal}` }) })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = await listExamples()
  if (files.length === 0) { console.error('no examples found'); process.exit(1) }
  for (const file of files) {
    console.log(`== ${file}`)
    const result = await run(file)
    if (!result.ok) { console.error(`example failed: ${file} ${result.why}`); process.exit(1) }
  }
  console.log(`${files.length} examples passed`)
}
