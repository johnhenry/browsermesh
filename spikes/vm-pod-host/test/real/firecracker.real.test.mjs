// REAL Firecracker test. Opt-in: `npm run test:real-firecracker` (from the
// repository root or from spikes/vm-pod-host) on a Linux/KVM host.
//
// *** THIS FILE HAS NEVER BEEN RUN AGAINST A REAL FIRECRACKER. ***
// It was written on macOS arm64, which has no /dev/kvm. Expect to fix it on
// first contact with a real host; what it asserts is the intended behaviour,
// not observed behaviour. Everything else in this spike's suite runs on any
// machine against a fake API and recorded host commands.
//
// What it needs (set as environment variables; nothing is downloaded):
//   FIRECRACKER_BIN  absolute path of the firecracker binary
//   JAILER_BIN       absolute path of the jailer binary
//   FC_KERNEL        absolute path of an uncompressed guest kernel (vmlinux)
//   FC_ROOTFS        absolute path of a rootfs.ext4 built by guest/build-rootfs.sh
//   root, /dev/kvm, `ip` and `nft` on PATH, IPv4 forwarding on
//
// Without all of that the suite SKIPS and reports success, like the other
// test:real-* suites. REQUIRE_REAL_FIRECRACKER=1 makes a missing prerequisite
// FAIL instead (set it where this is supposed to run, so it cannot silently
// become decorative).
//
// It boots one real microVM under the jailer and checks, in order: that the
// guest answers over vsock; boot and snapshot-restore timings (printed, the
// numbers issue #185 §9 asks for); that guest state survives snapshot and
// restore; that the guest CANNOT reach the metadata address or the host's own
// gateway address (the default network policy); and that draining leaves no
// VMM process and no nft table behind.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, constants, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { VmPodHost } from '../../src/host-pod.mjs'

const run = promisify(execFile)
const REQUIRED_ENV = ['FIRECRACKER_BIN', 'JAILER_BIN', 'FC_KERNEL', 'FC_ROOTFS']

/** @returns {Promise<string|null>} Why the suite cannot run here, or null. */
async function unmetPrerequisite() {
  if (process.platform !== 'linux') return `not Linux (${process.platform})`
  if (typeof process.getuid === 'function' && process.getuid() !== 0) return 'not root'
  for (const name of REQUIRED_ENV) {
    if (!process.env[name]) return `${name} is not set`
  }
  try {
    await access('/dev/kvm', constants.R_OK | constants.W_OK)
  } catch {
    return '/dev/kvm is not accessible'
  }
  for (const tool of ['ip', 'nft']) {
    try {
      await run('sh', ['-c', `command -v ${tool}`])
    } catch {
      return `${tool} is not on PATH`
    }
  }
  return null
}

/** The host command runner a real VmPodHost uses. */
async function realExec(argv) {
  try {
    const { stdout, stderr } = await run(argv[0], argv.slice(1), { maxBuffer: 1 << 20 })
    return { stdout, stderr, code: 0 }
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? String(err.message), code: typeof err.code === 'number' ? err.code : 1 }
  }
}

const unmet = await unmetPrerequisite()
const required = process.env.REQUIRE_REAL_FIRECRACKER === '1'

if (unmet && required) {
  describe('real Firecracker', () => {
    it('has its prerequisites (REQUIRE_REAL_FIRECRACKER=1)', () => {
      assert.fail(`REQUIRE_REAL_FIRECRACKER=1 but ${unmet}`)
    })
  })
} else if (unmet) {
  describe('real Firecracker', { skip: `skipped: ${unmet} (see the header of this file)` }, () => {
    it('is skipped without a Linux/KVM host', () => {})
  })
} else {
  describe('real Firecracker: one jailed microVM, end to end', () => {
    const NAME = 'realfc'
    let host
    let vm
    let workDir
    const timings = {}

    before(async () => {
      workDir = await mkdtemp(path.join(tmpdir(), 'real-fc-'))
      host = new VmPodHost({
        exec: realExec,
        jailer: { chrootBaseDir: path.join(workDir, 'jail') },
        signalingUrl: process.env.FC_SIGNALING_URL,
      })
      await host.start()
    })

    after(async () => {
      if (host && host.vms.has(NAME)) await host.drain(NAME).catch(() => {})
      if (workDir) await rm(workDir, { recursive: true, force: true })
      console.log('real Firecracker timings (ms):', JSON.stringify(timings))
    })

    it('boots under the jailer and answers an exec over vsock', async () => {
      const started = performance.now()
      vm = await host.spawn(NAME, {
        execFile: process.env.FIRECRACKER_BIN,
        kernelImage: process.env.FC_KERNEL,
        rootfsBase: process.env.FC_ROOTFS,
        limits: { vcpus: 1, memMib: 256 },
        vsock: { guestCid: 3, udsPath: 'unused-in-a-jail' },
        idleTimeoutMs: 0,
      })
      // The guest's own announcement over signaling is not part of this test:
      // the exec responder starts before the guest's Node process does.
      vm.markRegistered('real-firecracker-test')
      const result = await host.exec(NAME, ['echo', 'hello from the guest'])
      timings.bootToExecMs = Math.round(performance.now() - started)
      assert.equal(result.code, 0)
      assert.equal(result.stdout.trim(), 'hello from the guest')
    })

    it('keeps guest state across snapshot and restore', async () => {
      await host.exec(NAME, ['sh', '-c', 'echo persisted > /tmp/state'])
      await host.snapshot(NAME)
      assert.equal(vm.state, 'snapshotted')
      const started = performance.now()
      await host.restore(NAME)
      vm.markRegistered('real-firecracker-test')
      const result = await host.exec(NAME, ['cat', '/tmp/state'])
      timings.restoreToExecMs = Math.round(performance.now() - started)
      assert.equal(result.stdout.trim(), 'persisted')
    })

    it('cannot reach the cloud metadata address or the host itself', async () => {
      // Default egress policy: private, link-local and the host's own TAP
      // address are unreachable. `nc -w 2 -z` exits non-zero when it cannot connect.
      for (const target of ['169.254.169.254', '10.200.0.1']) {
        const result = await host.exec(NAME, ['nc', '-w', '2', '-z', target, '80'])
        assert.notEqual(result.code, 0, `the guest reached ${target}`)
      }
    })

    it('leaves no VMM process and no nft table behind after drain', async () => {
      await host.drain(NAME)
      const processes = await realExec(['pgrep', '-f', `--id ${NAME}`])
      assert.notEqual(processes.code, 0, `a VMM for ${NAME} is still running: ${processes.stdout}`)
      const tables = await realExec(['nft', 'list', 'tables'])
      assert.doesNotMatch(tables.stdout, new RegExp(`fc-${NAME}`))
    })
  })
}
