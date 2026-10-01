import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { runCli, buildLoopbackFixture, withTempIdentityDir } from './helpers.mjs'

describe('meshctl pods over --loopback', () => {
  /** @type {Awaited<ReturnType<typeof buildLoopbackFixture>>} */
  let fixture
  let isolateHost
  let nodeHost

  before(async () => {
    fixture = await buildLoopbackFixture({ timeoutMs: 5000 })
    const hosts = fixture.session.knownHosts()
    isolateHost = fixture.session.resolveHost('isolate-host').podId
    nodeHost = fixture.session.resolveHost('node-host').podId
    assert.ok(hosts.includes(isolateHost))
    assert.ok(hosts.includes(nodeHost))
  })

  after(async () => { await fixture.cleanup() })

  it('hosts describes both known hosts with lane/verbs/runtimeClasses', async () => {
    const { code, stdout } = await runCli(['hosts'], { session: fixture.session })
    assert.equal(code, 0)
    const { result } = JSON.parse(stdout)
    assert.equal(result.length, 2)
    const byLane = Object.fromEntries(result.map((h) => [h.lane, h]))
    assert.deepEqual(byLane.isolate.verbs, ['spawn', 'status', 'send', 'drain', 'list'])
    assert.deepEqual(byLane.isolate.runtimeClasses, ['isolate'])
    assert.deepEqual(byLane.node.verbs, ['spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list'])
    assert.deepEqual(byLane.node.runtimeClasses, ['node'])
  })

  it('host describe <host> describes one host', async () => {
    const { code, stdout } = await runCli(['host', 'describe', nodeHost], { session: fixture.session })
    assert.equal(code, 0)
    const { result } = JSON.parse(stdout)
    assert.equal(result.lane, 'node')
    assert.equal(result.shellBackend, 'pty')
  })

  it('pods list on a fresh host is empty', async () => {
    const { code, stdout } = await runCli(['pods', 'list', isolateHost], { session: fixture.session })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout).result, [])
  })

  describe('full verb lifecycle on the node-lane host', () => {
    it('spawn', async () => {
      const { code, stdout } = await runCli(
        ['pods', 'spawn', nodeHost, '--name', 'web', '--kind', 'command', '--ref', '/bin/sh', '--lane', 'node'],
        { session: fixture.session },
      )
      assert.equal(code, 0)
      const { result } = JSON.parse(stdout)
      assert.equal(result.host, nodeHost)
      assert.equal(result.pod.name, 'web')
      assert.equal(result.pod.state, 'registered')
    })

    it('status reflects the spawned pod', async () => {
      const { code, stdout } = await runCli(['pods', 'status', nodeHost, 'web'], { session: fixture.session })
      assert.equal(code, 0)
      assert.equal(JSON.parse(stdout).result.state, 'registered')
    })

    it('send delivers a payload', async () => {
      const { code, stdout } = await runCli(
        ['pods', 'send', nodeHost, 'web', '--payload', '{"hello":"world"}'],
        { session: fixture.session },
      )
      assert.equal(code, 0)
      assert.equal(JSON.parse(stdout).result.delivered, true)
    })

    it('exec runs a command', async () => {
      const { code, stdout } = await runCli(
        ['pods', 'exec', nodeHost, 'web', '--', 'echo', 'hi'],
        { session: fixture.session },
      )
      assert.equal(code, 0)
      const { result } = JSON.parse(stdout)
      assert.equal(result.code, 0)
      assert.equal(result.stdout, 'echo hi')
    })

    it('snapshot moves the pod to snapshotted', async () => {
      const { code, stdout } = await runCli(['pods', 'snapshot', nodeHost, 'web'], { session: fixture.session })
      assert.equal(code, 0)
      assert.equal(JSON.parse(stdout).result.state, 'snapshotted')
    })

    it('restore moves the pod back to registered', async () => {
      const { code, stdout } = await runCli(['pods', 'restore', nodeHost, 'web'], { session: fixture.session })
      assert.equal(code, 0)
      assert.equal(JSON.parse(stdout).result.state, 'registered')
    })

    it('drain --cascade moves the pod to gone', async () => {
      const { code, stdout } = await runCli(['pods', 'drain', nodeHost, 'web', '--cascade'], { session: fixture.session })
      assert.equal(code, 0)
      assert.equal(JSON.parse(stdout).result.state, 'gone')
    })

    it('list now reports the pod as gone', async () => {
      const { code, stdout } = await runCli(['pods', 'list', nodeHost], { session: fixture.session })
      assert.equal(code, 0)
      const { result } = JSON.parse(stdout)
      assert.deepEqual(result.map((p) => [p.name, p.state]), [['web', 'gone']])
    })
  })

  describe('isolate lane refuses shell-dependent verbs with ELANE', () => {
    before(async () => {
      const { code } = await runCli(
        ['pods', 'spawn', isolateHost, '--name', 'skillpod', '--kind', 'skill', '--ref', 'some-skill'],
        { session: fixture.session },
      )
      assert.equal(code, 0)
    })

    it('exec on an isolate host is ELANE (exit 5)', async () => {
      const { code, stderr } = await runCli(
        ['pods', 'exec', isolateHost, 'skillpod', '--', 'echo', 'nope'],
        { session: fixture.session },
      )
      assert.equal(code, 5)
      assert.equal(JSON.parse(stderr).error.code, 'ELANE')
    })

    it('snapshot on an isolate host is ELANE (exit 5)', async () => {
      const { code, stderr } = await runCli(
        ['pods', 'snapshot', isolateHost, 'skillpod'],
        { session: fixture.session },
      )
      assert.equal(code, 5)
      assert.equal(JSON.parse(stderr).error.code, 'ELANE')
    })
  })

  describe('pods spawn auto', () => {
    it('picks the node-lane host for lane=node (orchestrator scoring)', async () => {
      const { code, stdout } = await runCli(
        ['pods', 'spawn', 'auto', '--lane', 'node', '--name', 'auto1', '--kind', 'command', '--ref', '/bin/sh'],
        { session: fixture.session },
      )
      assert.equal(code, 0)
      const { result } = JSON.parse(stdout)
      assert.equal(result.host, nodeHost)
      assert.equal(result.chosenVia, 'orchestrator')
    })

    it('picks the isolate-lane host for lane=isolate (falls back to lane-match)', async () => {
      const { code, stdout } = await runCli(
        ['pods', 'spawn', 'auto', '--lane', 'isolate', '--name', 'auto2', '--kind', 'skill', '--ref', 'x'],
        { session: fixture.session },
      )
      assert.equal(code, 0)
      const { result } = JSON.parse(stdout)
      assert.equal(result.host, isolateHost)
      assert.equal(result.chosenVia, 'lane-match')
    })

    it('without --lane is a usage error', async () => {
      const { code, stderr } = await runCli(
        ['pods', 'spawn', 'auto', '--name', 'auto3', '--kind', 'command', '--ref', '/bin/sh'],
        { session: fixture.session },
      )
      assert.equal(code, 2)
      assert.equal(JSON.parse(stderr).error.code, 'EUSAGE')
    })
  })

  describe('--spec file + flag overrides', () => {
    it('layers --env on top of a --spec file', async () => {
      const { dir, cleanup } = await withTempIdentityDir()
      try {
        const specPath = `${dir}/spec.json`
        await writeFile(specPath, JSON.stringify({
          name: 'specced', lane: 'node', run: { kind: 'command', ref: '/bin/sh' }, env: { A: '1' },
        }))
        const { code, stdout } = await runCli(
          ['pods', 'spawn', nodeHost, '--spec', specPath, '--env', 'B=2'],
          { session: fixture.session },
        )
        assert.equal(code, 0)
        const { result } = JSON.parse(stdout)
        assert.equal(result.pod.name, 'specced')
        assert.deepEqual(result.pod.spec.env, { A: '1', B: '2' })
      } finally {
        await cleanup()
      }
    })
  })
})
