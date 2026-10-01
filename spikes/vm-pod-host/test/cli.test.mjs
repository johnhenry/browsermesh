import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, main } from '../src/cli.mjs'

describe('cli parseArgs', () => {
  it('parses a bare command', () => {
    assert.deepEqual(parseArgs(['status']), { command: 'status', name: undefined, rest: [], dryRun: false, kernel: '/boot/vmlinux', rootfs: '/var/lib/vm-pod-host/demo/rootfs.ext4' })
  })

  it('parses a command, name, and --dry-run', () => {
    const parsed = parseArgs(['spawn', 'demo', '--dry-run'])
    assert.equal(parsed.command, 'spawn')
    assert.equal(parsed.name, 'demo')
    assert.equal(parsed.dryRun, true)
  })

  it('parses exec args after --', () => {
    const parsed = parseArgs(['exec', 'demo', '--dry-run', '--', 'ls', '-la'])
    assert.deepEqual(parsed.rest, ['ls', '-la'])
  })

  it('parses --kernel and --rootfs overrides', () => {
    const parsed = parseArgs(['spawn', 'demo', '--kernel', '/tmp/vmlinux', '--rootfs', '/tmp/rootfs.ext4'])
    assert.equal(parsed.kernel, '/tmp/vmlinux')
    assert.equal(parsed.rootfs, '/tmp/rootfs.ext4')
  })
})

describe('cli main', () => {
  it('refuses to run without --dry-run', async () => {
    const lines = []
    const code = await main(['spawn', 'demo'], { log: (l) => lines.push(l) })
    assert.equal(code, 1)
    assert.ok(lines.some((l) => l.includes('refusing to run outside --dry-run')))
  })

  it('spawn --dry-run prints planned commands and API calls', async () => {
    const lines = []
    const code = await main(['spawn', 'demo', '--dry-run'], { log: (l) => lines.push(l) })
    assert.equal(code, 0)
    const out = lines.join('\n')
    assert.match(out, /planned host commands:/)
    assert.match(out, /ip tuntap add tap-demo mode tap/)
    assert.match(out, /planned Firecracker API calls:/)
    assert.match(out, /putMachineConfig/)
    assert.match(out, /putBootSource/)
    assert.match(out, /putDrive/)
    assert.match(out, /putNetworkInterface/)
    assert.match(out, /putVsock/)
    assert.match(out, /start\(\)/)
  })

  it('status --dry-run prints an empty host status', async () => {
    const lines = []
    const code = await main(['status', '--dry-run'], { log: (l) => lines.push(l) })
    assert.equal(code, 0)
    assert.ok(lines.some((l) => l.trim() === '{}'))
  })

  it('unknown command returns exit code 1', async () => {
    const lines = []
    const code = await main(['bogus', '--dry-run'], { log: (l) => lines.push(l) })
    assert.equal(code, 1)
  })
})
