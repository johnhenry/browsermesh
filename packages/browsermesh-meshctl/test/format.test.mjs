import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { runCli, buildLoopbackFixture } from './helpers.mjs'

describe('--json / --pretty formatting', () => {
  let fixture
  after(async () => { if (fixture) await fixture.cleanup() })

  it('defaults to compact when stdout is not a TTY', async () => {
    const { stdout } = await runCli(['--help'], { isTTY: false })
    assert.equal(stdout, `${stdout.trim()}\n`)
    assert.equal(stdout.trim().includes('\n  '), false) // no multi-line indentation
  })

  it('defaults to pretty when stdout IS a TTY', async () => {
    const { stdout } = await runCli(['--help'], { isTTY: true })
    assert.match(stdout, /\n\s+"name"/)
  })

  it('--json forces compact even on a TTY', async () => {
    const { stdout } = await runCli(['--help', '--json'], { isTTY: true })
    assert.equal(stdout.includes('\n  '), false)
  })

  it('--pretty forces pretty even off a TTY', async () => {
    const { stdout } = await runCli(['--help', '--pretty'], { isTTY: false })
    assert.match(stdout, /\n\s+"name"/)
  })

  it('every stdout write is a single JSON document, one per command', async () => {
    fixture = await buildLoopbackFixture({ timeoutMs: 2000 })
    const { stdout } = await runCli(['hosts'], { session: fixture.session })
    const lines = stdout.trim().split('\n')
    // Compact mode (non-TTY) -> exactly one line, and it parses as one document.
    assert.equal(lines.length, 1)
    assert.doesNotThrow(() => JSON.parse(stdout))
  })

  it('--quiet suppresses stderr diagnostics without touching stdout', async () => {
    const { stdout, stderr } = await runCli(['--help', '--quiet'], { isTTY: false })
    assert.doesNotThrow(() => JSON.parse(stdout))
    assert.equal(stderr, '')
  })
})
