/**
 * Tests for `meshctl pods supervise`/`pods supervised`/`pods crash` over
 * `--loopback` (issue #185 item 6) -- a real restart, driven entirely
 * through the CLI surface: crash a supervised pod, watch it come back.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { runCli, buildLoopbackFixture } from './helpers.mjs'
import { cmdPodsCrash } from '../src/commands.mjs'
import { UsageError } from '../src/output.mjs'

describe('meshctl pods supervise/supervised/crash over --loopback', () => {
  /** @type {Awaited<ReturnType<typeof buildLoopbackFixture>>} */
  let fixture
  let nodeHost

  before(async () => {
    fixture = await buildLoopbackFixture({ timeoutMs: 5000 })
    nodeHost = fixture.session.resolveHost('node-host').podId
  })

  after(async () => { await fixture.cleanup() })

  it('supervise spawns a pod under restart policy on-failure', async () => {
    const { code, stdout } = await runCli(
      [
        'pods', 'supervise', nodeHost, '--name', 'sup1', '--kind', 'command', '--ref', '/bin/sh',
        '--lane', 'node', '--restart', 'on-failure', '--backoff', '5',
      ],
      { session: fixture.session },
    )
    assert.equal(code, 0)
    const { result } = JSON.parse(stdout)
    assert.equal(result.host, nodeHost)
    assert.equal(result.ref.name, 'sup1')
    assert.equal(result.pod.state, 'registered')
  })

  it('supervised lists the pod with restarts: 0', async () => {
    const { code, stdout } = await runCli(['pods', 'supervised'], { session: fixture.session })
    assert.equal(code, 0)
    const { result } = JSON.parse(stdout)
    const entry = result.find((p) => p.ref.name === 'sup1')
    assert.ok(entry)
    assert.equal(entry.state, 'running')
    assert.equal(entry.restarts, 0)
  })

  it('crash forces the pod to gone with reason crashed', async () => {
    const { code, stdout } = await runCli(['pods', 'crash', nodeHost, 'sup1'], { session: fixture.session })
    assert.equal(code, 0)
    const { result } = JSON.parse(stdout)
    assert.equal(result.state, 'gone')
  })

  it('the supervisor restarts the crashed pod (restarts: 1, state: running again)', async () => {
    // backoffMs: 5 -- short enough to wait out for real rather than fake timers.
    await new Promise((resolve) => { setTimeout(resolve, 200) })
    const { code, stdout } = await runCli(['pods', 'supervised'], { session: fixture.session })
    assert.equal(code, 0)
    const { result } = JSON.parse(stdout)
    const entry = result.find((p) => p.ref.name === 'sup1')
    assert.ok(entry)
    assert.equal(entry.state, 'running')
    assert.equal(entry.restarts, 1)

    const statusResult = await runCli(['pods', 'status', nodeHost, 'sup1'], { session: fixture.session })
    assert.equal(JSON.parse(statusResult.stdout).result.state, 'registered')
  })

  it('pods crash refuses outside --loopback (a mode: real session has no loopbackDriverFor)', async () => {
    const fakeRealSession = { mode: 'real' }
    await assert.rejects(
      cmdPodsCrash(fakeRealSession, { positionals: [nodeHost, 'sup1'], flags: {} }),
      (err) => err instanceof UsageError && /only available over --loopback/.test(err.message),
    )
  })
})
