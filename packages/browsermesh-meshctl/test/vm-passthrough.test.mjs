import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runCli } from './helpers.mjs'
import { runVmCommand, VM_COMMANDS } from '../src/vm-bridge.mjs'

describe('meshctl vm (passthrough to spikes/vm-pod-host)', () => {
  it('exposes exactly the six verbs the spike CLI supports', () => {
    assert.deepEqual(VM_COMMANDS, ['spawn', 'exec', 'snapshot', 'restore', 'drain', 'status'])
  })

  it('vm spawn demo --dry-run via the CLI prints a JSON document with the planned calls', async () => {
    const { code, stdout } = await runCli(['vm', 'spawn', 'demo', '--dry-run'])
    assert.equal(code, 0)
    const { ok, result } = JSON.parse(stdout)
    assert.equal(ok, true)
    assert.equal(result.name, 'demo')
    assert.equal(result.state, 'registered')
    assert.ok(result.plannedCommands.length > 0)
    assert.ok(result.plannedApiCalls.some((c) => c.api === 'putMachineConfig'))
    assert.ok(result.plannedApiCalls.some((c) => c.api === 'start'))
  })

  it('vm exec runs the given argv against the demo VM', async () => {
    const { code, stdout } = await runCli(['vm', 'exec', 'demo', '--dry-run', '--', 'ls', '-la'])
    assert.equal(code, 0)
    const { result } = JSON.parse(stdout)
    assert.equal(result.exec.code, 0)
  })

  it('vm snapshot / restore / drain round-trip', async () => {
    const snap = await runCli(['vm', 'snapshot', 'demo', '--dry-run'])
    assert.equal(JSON.parse(snap.stdout).result.state, 'snapshotted')

    // restore() leaves the pod in 'restoring' until the guest re-announces
    // via markRegistered() -- see spikes/vm-pod-host/src/vm-pod.mjs's own
    // doc comment on restore(); the demo lifecycle here never calls that
    // again after restore, same as the spike CLI's own 'restore' command.
    const restore = await runCli(['vm', 'restore', 'demo', '--dry-run'])
    assert.equal(JSON.parse(restore.stdout).result.state, 'restoring')

    const drain = await runCli(['vm', 'drain', 'demo', '--dry-run'])
    assert.equal(JSON.parse(drain.stdout).result.state, 'cold')
  })

  it('vm status needs no --dry-run and reports an empty host with no pods', async () => {
    const { code, stdout } = await runCli(['vm', 'status'])
    assert.equal(code, 0)
    const { result } = JSON.parse(stdout)
    assert.deepEqual(result.pods, {})
    assert.equal(typeof result.hostPodId, 'string')
  })

  it('vm <command> without a name (besides status) is a usage error', async () => {
    const { code, stderr } = await runCli(['vm', 'spawn', '--dry-run'])
    assert.equal(code, 2)
    assert.equal(JSON.parse(stderr).error.code, 'EUSAGE')
  })

  it('runVmCommand() is directly importable and usable without the CLI layer', async () => {
    const result = await runVmCommand({ command: 'spawn', name: 'lib-demo', dryRun: true })
    assert.equal(result.name, 'lib-demo')
    assert.equal(result.state, 'registered')
  })

  it('an unknown vm command is rejected with EUSAGE', async () => {
    await assert.rejects(runVmCommand({ command: 'bogus', dryRun: true }), /EUSAGE|unknown command/)
  })
})
