import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { runCli, buildLoopbackFixture } from './helpers.mjs'

describe('meshctl watch', () => {
  let fixture
  after(async () => { if (fixture) await fixture.cleanup() })

  it('streams at least one lifecycle event as NDJSON, then a final summary document, until the signal aborts', async () => {
    fixture = await buildLoopbackFixture({ timeoutMs: 5000 })
    const host = fixture.session.resolveHost('node-host').podId

    const controller = new AbortController()
    const watchPromise = runCli(['watch', host], { session: fixture.session, signal: controller.signal })

    // Give `watch`'s initial list()/registerInterest() poll a moment, then
    // cause a lifecycle event the watcher should observe.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await fixture.session.client.spawn(host, {
      name: 'watched', lane: 'node', run: { kind: 'command', ref: '/bin/sh' },
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    controller.abort()

    const { code, stdoutLines } = await watchPromise
    assert.equal(code, 0)

    // Every line but the last is one NDJSON lifecycle event; the last line
    // is the one `{ok, result}` summary document `cli.mjs` always prints.
    assert.ok(stdoutLines.length >= 2, `expected at least one event + the summary, got ${stdoutLines.length} lines`)
    const events = stdoutLines.slice(0, -1).map((line) => JSON.parse(line))
    assert.ok(events.length >= 1)
    for (const event of events) {
      assert.equal(event.host, host)
      assert.equal(event.kind, 'lifecycle')
      assert.equal(event.data.name, 'watched')
    }
    assert.ok(events.some((e) => e.data.from === 'cold' && e.data.to === 'booting'))

    const summary = JSON.parse(stdoutLines[stdoutLines.length - 1])
    assert.equal(summary.ok, true)
    assert.equal(summary.result.stopped, true)
    assert.equal(summary.result.events, events.length)
  })
})
