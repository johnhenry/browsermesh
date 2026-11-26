// `pods supervise auto` with --requester or --min-boundary hands placement, at supervise time and at every restart, to
// the placement planner under THAT requester (its trust read from the CLI's trust graph), never under meshctl's own.
// Without either flag nothing changes.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { runCli, buildLoopbackFixture } from './helpers.mjs'

const sleepMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

describe('meshctl pods supervise auto: the planner and the original requester', () => {
  let fixture
  const supervise = (extra) => runCli(
    ['pods', 'supervise', 'auto', '--kind', 'command', '--ref', '/bin/sh', '--lane', 'node', '--restart', 'always', '--backoff', '5', ...extra],
    { session: fixture.session },
  )
  const supervised = async () => JSON.parse((await runCli(['pods', 'supervised'], { session: fixture.session })).stdout).result

  before(async () => { fixture = await buildLoopbackFixture({ timeoutMs: 5000 }) })
  after(async () => { await fixture.cleanup() })

  it('without a placement flag nothing changes: chosen as before, no requester recorded', async () => {
    const { code, stdout } = await supervise(['--name', 'plain'])
    assert.equal(code, 0)
    const { result } = JSON.parse(stdout)
    assert.ok(['orchestrator', 'lane-match'].includes(result.chosenVia))
    assert.equal('requesterId' in (await supervised()).find((p) => p.ref.name === 'plain'), false)
  })

  it('an untrusted requester is refused at supervise time (EACCES) and nothing is supervised', async () => {
    const { code, stderr } = await supervise(['--name', 'refused', '--requester', 'mallory'])
    assert.equal(code, 3)
    assert.match(stderr, /no host may take this pod/)
    assert.equal((await supervised()).some((p) => p.ref.name === 'refused'), false)
  })

  it('a bad boundary name or an empty requester is a usage error', async () => {
    assert.equal((await supervise(['--name', 'bad1', '--requester', 'alice-key', '--min-boundary', 'strong'])).code, 2)
    assert.equal((await supervise(['--name', 'bad2', '--requester', ''])).code, 2)
  })

  it('a trusted requester is placed by the planner, recorded, and re-placed under the same requester after a crash', async () => {
    fixture.session.peerNode.registry.setTrust('alice-key', 0.95)
    const { code, stdout } = await supervise(['--name', 'planned', '--requester', 'alice-key'])
    assert.equal(code, 0)
    const { result } = JSON.parse(stdout)
    assert.equal(result.chosenVia, 'planner')
    assert.equal((await supervised()).find((p) => p.ref.name === 'planned').requesterId, 'alice-key')

    const host = result.host
    assert.equal((await runCli(['pods', 'crash', host, 'planned'], { session: fixture.session })).code, 0)
    await sleepMs(200)
    const entry = (await supervised()).find((p) => p.ref.name === 'planned')
    assert.equal(entry.state, 'running')
    assert.equal(entry.restarts, 1)
    assert.equal(entry.requesterId, 'alice-key')
  })

  it('when that requester is no longer trusted at a restart the pod is not re-placed: it stops, and nothing is spawned in its place', async () => {
    fixture.session.peerNode.registry.setTrust('alice-key', 0.95)
    const { stdout } = await supervise(['--name', 'revoked', '--requester', 'alice-key', '--min-boundary', 'none'])
    const host = JSON.parse(stdout).result.host
    // Trust is withdrawn; the host states no boundary, so an untrusted requester may be placed nowhere.
    fixture.session.peerNode.registry.setTrust('alice-key', 0.1)
    await runCli(['pods', 'crash', host, 'revoked'], { session: fixture.session })
    await sleepMs(200)
    const entry = (await supervised()).find((p) => p.ref.name === 'revoked')
    assert.equal(entry.state, 'dead')
    const listed = JSON.parse((await runCli(['pods', 'list', host], { session: fixture.session })).stdout).result
    assert.equal(listed.find((p) => p.name === 'revoked').state, 'gone')
  })
})
