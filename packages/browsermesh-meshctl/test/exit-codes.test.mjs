import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { runCli, buildLoopbackFixture } from './helpers.mjs'

describe('exit code mapping', () => {
  /** @type {Array<() => Promise<void>>} */
  const cleanups = []
  after(async () => { for (const fn of cleanups.reverse()) await fn() })

  it('EACCES -> exit 3 (host never granted meshctl anything)', async () => {
    const fixture = await buildLoopbackFixture({
      timeoutMs: 2000,
      hosts: [{ label: 'nogrant', lane: 'node', grant: false }],
    })
    cleanups.push(fixture.cleanup)

    const { code, stdout, stderr } = await runCli(['pods', 'list', 'nogrant'], { session: fixture.session })
    assert.equal(code, 3)
    assert.equal(stdout, '')
    const doc = JSON.parse(stderr)
    assert.equal(doc.ok, false)
    assert.equal(doc.error.code, 'EACCES')
  })

  it('ENOENT -> exit 4 (no such pod)', async () => {
    const fixture = await buildLoopbackFixture({ timeoutMs: 2000 })
    cleanups.push(fixture.cleanup)
    const host = fixture.session.resolveHost('node-host').podId

    const { code, stderr } = await runCli(['pods', 'status', host, 'does-not-exist'], { session: fixture.session })
    assert.equal(code, 4)
    assert.equal(JSON.parse(stderr).error.code, 'ENOENT')
  })

  it('ELANE -> exit 5 (verb structurally unsupported by the lane)', async () => {
    const fixture = await buildLoopbackFixture({ timeoutMs: 2000 })
    cleanups.push(fixture.cleanup)
    const host = fixture.session.resolveHost('isolate-host').podId

    const spawn = await runCli(
      ['pods', 'spawn', host, '--name', 'x', '--kind', 'skill', '--ref', 'y'],
      { session: fixture.session },
    )
    assert.equal(spawn.code, 0)

    const { code, stderr } = await runCli(['pods', 'exec', host, 'x', '--', 'echo', 'hi'], { session: fixture.session })
    assert.equal(code, 5)
    assert.equal(JSON.parse(stderr).error.code, 'ELANE')
  })

  it('ETIMEDOUT -> exit 6 (host never responds)', async () => {
    const fixture = await buildLoopbackFixture({
      timeoutMs: 100,
      hosts: [{ label: 'deaf', lane: 'node', attach: false }],
    })
    cleanups.push(fixture.cleanup)

    const { code, stderr } = await runCli(['pods', 'list', 'deaf'], { session: fixture.session })
    assert.equal(code, 6)
    assert.equal(JSON.parse(stderr).error.code, 'ETIMEDOUT')
  })

  describe('`hosts`: every entry is printed, the exit code says whether anything worked (#432)', () => {
    /** The entries `hosts` printed on stdout, whatever the exit code. */
    const entries = (stdout) => JSON.parse(stdout).result

    it('exits 0 when at least one host answered, and still prints the failed one with its error', async () => {
      const fixture = await buildLoopbackFixture({
        timeoutMs: 150,
        hosts: [{ label: 'ok', lane: 'node' }, { label: 'deaf', lane: 'isolate', attach: false }],
      })
      cleanups.push(fixture.cleanup)
      const { code, stdout } = await runCli(['hosts'], { session: fixture.session })
      assert.equal(code, 0)
      const list = entries(stdout)
      assert.deepEqual(list.filter((e) => e.error).map((e) => e.error.code), ['ETIMEDOUT'])
      assert.equal(list.filter((e) => e.lane).length, 1)
    })

    it('exits with the shared code when every host failed the same way (timeouts: 6)', async () => {
      const fixture = await buildLoopbackFixture({
        timeoutMs: 100,
        hosts: [{ label: 'deaf1', lane: 'node', attach: false }, { label: 'deaf2', lane: 'isolate', attach: false }],
      })
      cleanups.push(fixture.cleanup)
      const { code, stdout } = await runCli(['hosts'], { session: fixture.session })
      assert.equal(code, 6)
      assert.deepEqual(entries(stdout).map((e) => e.error?.code), ['ETIMEDOUT', 'ETIMEDOUT'])
    })
  })

  it('a generic/unknown error code maps to exit 1', async () => {
    const fixture = await buildLoopbackFixture({ timeoutMs: 2000 })
    cleanups.push(fixture.cleanup)
    const host = fixture.session.resolveHost('node-host').podId

    // Spawning the same name twice hits EEXIST, which has no dedicated
    // exit code in the design doc -- it should fall through to GENERIC.
    const first = await runCli(
      ['pods', 'spawn', host, '--name', 'dup', '--lane', 'node', '--kind', 'command', '--ref', '/bin/sh'],
      { session: fixture.session },
    )
    assert.equal(first.code, 0)
    const { code, stderr } = await runCli(
      ['pods', 'spawn', host, '--name', 'dup', '--lane', 'node', '--kind', 'command', '--ref', '/bin/sh'],
      { session: fixture.session },
    )
    assert.equal(code, 1)
    assert.equal(JSON.parse(stderr).error.code, 'EEXIST')
  })

  it('a podspec for another lane than the host runs is ELANE (exit 5), not placed on it anyway', async () => {
    const fixture = await buildLoopbackFixture({ timeoutMs: 2000 })
    cleanups.push(fixture.cleanup)
    const host = fixture.session.resolveHost('node-host').podId
    // `--kind command` with no --lane means the microvm lane; a node host does not run it.
    const { code, stderr } = await runCli(
      ['pods', 'spawn', host, '--name', 'wrong-lane', '--kind', 'command', '--ref', '/bin/sh'],
      { session: fixture.session },
    )
    assert.equal(code, 5)
    assert.equal(JSON.parse(stderr).error.code, 'ELANE')
  })
})
