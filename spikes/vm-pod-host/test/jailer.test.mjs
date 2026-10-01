import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildJailerArgv, jailerApiSocketPath } from '../src/jailer.mjs'

describe('buildJailerArgv', () => {
  it('builds the minimal required argv', () => {
    const argv = buildJailerArgv({ id: 'demo', execFile: '/usr/bin/firecracker', uid: 123, gid: 100 })
    assert.deepEqual(argv, [
      'jailer',
      '--id', 'demo',
      '--exec-file', '/usr/bin/firecracker',
      '--uid', '123',
      '--gid', '100',
      '--chroot-base-dir', '/srv/jailer',
    ])
  })

  it('includes --netns when given', () => {
    const argv = buildJailerArgv({
      id: 'demo', execFile: '/usr/bin/firecracker', uid: 123, gid: 100,
      netns: '/var/run/netns/fc-demo',
    })
    assert.ok(argv.includes('--netns'))
    assert.equal(argv[argv.indexOf('--netns') + 1], '/var/run/netns/fc-demo')
  })

  it('emits one --cgroup flag per entry, in order', () => {
    const argv = buildJailerArgv({
      id: 'demo', execFile: '/usr/bin/firecracker', uid: 123, gid: 100,
      cgroups: ['cpu.cfs_quota_us=50000', 'memory.limit_in_bytes=67108864'],
    })
    const cgroupIdxs = argv.reduce((acc, v, i) => (v === '--cgroup' ? [...acc, i] : acc), [])
    assert.equal(cgroupIdxs.length, 2)
    assert.equal(argv[cgroupIdxs[0] + 1], 'cpu.cfs_quota_us=50000')
    assert.equal(argv[cgroupIdxs[1] + 1], 'memory.limit_in_bytes=67108864')
  })

  it('includes --cgroup-version and --parent-cgroup when given', () => {
    const argv = buildJailerArgv({
      id: 'demo', execFile: '/usr/bin/firecracker', uid: 123, gid: 100,
      cgroupVersion: '2', parentCgroup: 'firecracker.slice',
    })
    assert.equal(argv[argv.indexOf('--cgroup-version') + 1], '2')
    assert.equal(argv[argv.indexOf('--parent-cgroup') + 1], 'firecracker.slice')
  })

  it('includes --daemonize and --new-pid-ns as bare flags', () => {
    const argv = buildJailerArgv({
      id: 'demo', execFile: '/usr/bin/firecracker', uid: 123, gid: 100,
      daemonize: true, newPidNs: true,
    })
    assert.ok(argv.includes('--daemonize'))
    assert.ok(argv.includes('--new-pid-ns'))
  })

  it('appends firecrackerArgs after a -- separator', () => {
    const argv = buildJailerArgv({
      id: 'demo', execFile: '/usr/bin/firecracker', uid: 123, gid: 100,
      firecrackerArgs: ['--api-sock', '/run/firecracker.socket'],
    })
    const sepIdx = argv.indexOf('--')
    assert.ok(sepIdx > 0)
    assert.deepEqual(argv.slice(sepIdx + 1), ['--api-sock', '/run/firecracker.socket'])
  })

  it('uses a custom jailerBin when given', () => {
    const argv = buildJailerArgv({ id: 'demo', execFile: '/usr/bin/firecracker', uid: 0, gid: 0, jailerBin: '/usr/local/bin/jailer' })
    assert.equal(argv[0], '/usr/local/bin/jailer')
  })

  it('rejects a missing id', () => {
    assert.throws(() => buildJailerArgv({ execFile: '/usr/bin/firecracker', uid: 0, gid: 0 }), /id is required/)
  })

  it('rejects an id with invalid characters', () => {
    assert.throws(
      () => buildJailerArgv({ id: 'demo/../etc', execFile: '/usr/bin/firecracker', uid: 0, gid: 0 }),
      /must match/,
    )
  })

  it('rejects a missing execFile', () => {
    assert.throws(() => buildJailerArgv({ id: 'demo', uid: 0, gid: 0 }), /execFile is required/)
  })

  it('rejects missing uid/gid', () => {
    assert.throws(() => buildJailerArgv({ id: 'demo', execFile: '/usr/bin/firecracker', gid: 0 }), /uid is required/)
    assert.throws(() => buildJailerArgv({ id: 'demo', execFile: '/usr/bin/firecracker', uid: 0 }), /gid is required/)
  })
})

describe('jailerApiSocketPath', () => {
  it('computes the default chroot-relative socket path', () => {
    const path = jailerApiSocketPath({ execFile: '/usr/bin/firecracker', id: 'demo' })
    assert.equal(path, '/srv/jailer/firecracker/demo/root/run/firecracker.socket')
  })

  it('respects a custom chrootBaseDir', () => {
    const path = jailerApiSocketPath({ execFile: '/usr/bin/firecracker', id: 'demo', chrootBaseDir: '/var/lib/fc-jail' })
    assert.equal(path, '/var/lib/fc-jail/firecracker/demo/root/run/firecracker.socket')
  })

  it('respects a custom apiSockRelPath (mirroring a --api-sock override)', () => {
    const path = jailerApiSocketPath({ execFile: '/usr/bin/firecracker', id: 'demo', apiSockRelPath: 'api.socket' })
    assert.equal(path, '/srv/jailer/firecracker/demo/root/api.socket')
  })

  it('derives execFileName from the basename of execFile', () => {
    const path = jailerApiSocketPath({ execFile: '/opt/bin/firecracker-v1.7', id: 'demo' })
    assert.ok(path.includes('/firecracker-v1.7/demo/root/'))
  })

  it('requires execFile and id', () => {
    assert.throws(() => jailerApiSocketPath({ id: 'demo' }), /execFile is required/)
    assert.throws(() => jailerApiSocketPath({ execFile: '/usr/bin/firecracker' }), /id is required/)
  })
})
