import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { runCli, buildLoopbackFixture } from './helpers.mjs'

// `pods spawn auto` with no placement flag picks as it always did; with
// --requester, --min-boundary or --max-pods-per-requester the placement
// planner decides, with the requester's trust read from the CLI's trust graph.
describe('meshctl pods spawn auto: placement constraints', () => {
  let fixture
  const spawn = (extra) => runCli(
    ['pods', 'spawn', 'auto', '--kind', 'skill', '--ref', 'greeter', ...extra],
    { session: fixture.session },
  )

  before(async () => { fixture = await buildLoopbackFixture({ timeoutMs: 5000 }) })
  after(async () => { await fixture.cleanup() })

  it('without a placement flag nothing changes: the host is picked as before', async () => {
    const { code, stdout } = await spawn(['--name', 'plain'])
    assert.equal(code, 0)
    const { result } = JSON.parse(stdout)
    assert.ok(['orchestrator', 'lane-match'].includes(result.chosenVia))
    assert.equal(result.placement, undefined)
  })

  it('an unknown requester is untrusted and a host that states no boundary is refused (exit EACCES)', async () => {
    const { code, stderr } = await spawn(['--name', 'c1', '--requester', 'mallory'])
    assert.equal(code, 3)
    assert.match(stderr, /no host may take this pod/)
  })

  it('a requester the CLI trusts is placed, and the decision is in the output', async () => {
    fixture.session.peerNode.registry.setTrust('alice-key', 0.95)
    const { code, stdout } = await spawn(['--name', 'c2', '--requester', 'alice-key'])
    assert.equal(code, 0)
    const { result } = JSON.parse(stdout)
    assert.equal(result.chosenVia, 'planner')
    assert.equal(result.placement.trust, 'trusted')
    assert.equal(result.placement.requesterId, 'alice-key')
    assert.equal(result.pod.name, 'c2')
  })

  it('a minimum boundary refuses even a trusted requester on hosts that state none', async () => {
    const { code } = await spawn(['--name', 'c3', '--requester', 'alice-key', '--min-boundary', 'language'])
    assert.equal(code, 3)
  })

  it('a bad boundary name is a usage error, not a placement', async () => {
    const { code } = await spawn(['--name', 'c5', '--requester', 'alice-key', '--min-boundary', 'strong'])
    assert.equal(code, 2)
  })
})
