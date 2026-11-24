/**
 * jailer.mjs — pure functions for building the `jailer` command line and
 * computing where the resulting Firecracker API socket ends up on the
 * host filesystem.
 *
 * `jailer` is the Firecracker project's setuid-root wrapper: it builds a
 * chroot for the VMM process, moves the `firecracker` binary into it,
 * drops privileges to a dedicated uid/gid, optionally joins a network
 * namespace, and applies cgroup limits — all *before* exec'ing
 * `firecracker` inside the jail. Always use it for untrusted guest code
 * (see docs/jailer.md on the Firecracker `main` branch, fetched
 * 2026-09-30).
 *
 * This module does not spawn anything itself — `buildJailerArgv` returns
 * a plain argv array that the caller (vm-pod.mjs, via its injectable
 * `exec`) is responsible for running. That keeps this module trivially
 * unit-testable without a real jailer binary, cgroups, or root.
 */

/**
 * @typedef {object} JailerOptions
 * @property {string} id - VM id; becomes the chroot's leaf directory name.
 *   Must match `^[0-9A-Za-z-]{1,64}$` (jailer's own validation) — this
 *   module does not re-validate, it is the caller's job.
 * @property {string} execFile - absolute path to the (statically linked)
 *   `firecracker` binary jailer will copy into the chroot and exec.
 * @property {number} uid - uid to drop privileges to inside the jail
 * @property {number} gid - gid to drop privileges to inside the jail
 * @property {string} [chrootBaseDir='/srv/jailer'] - jail base directory
 * @property {string} [netns] - path to a network namespace to join
 *   (e.g. `/var/run/netns/fc-demo`), passed via `--netns`
 * @property {string[]} [cgroups] - cgroup v1/v2 controller settings as
 *   `"<file>=<value>"` strings, one `--cgroup` flag per entry
 *   (e.g. `"cpu.cfs_quota_us=50000"`, `"memory.limit_in_bytes=67108864"`)
 * @property {'1'|'2'} [cgroupVersion] - forces cgroup v1 or v2 hierarchy
 * @property {string} [parentCgroup] - nest the jail's cgroup under this
 *   existing cgroup instead of `<exec_file_name>.<id>`
 * @property {boolean} [daemonize=false] - detach and redirect stdio to
 *   /dev/null after jailing (jailer's `--daemonize`)
 * @property {boolean} [newPidNs=false] - spawn in a new PID namespace
 *   (jailer's `--new-pid-ns`)
 * @property {string} [jailerBin='jailer'] - jailer executable to invoke
 * @property {string[]} [firecrackerArgs=[]] - extra args forwarded to
 *   `firecracker` after the `--` separator (e.g. `['--api-sock', '/run/firecracker.socket']`)
 */

/**
 * Build the argv for a `jailer` invocation.
 *
 * Returns a plain array suitable for `execFile`/`spawn`/an injectable
 * `exec(argv)` — argv[0] is the jailer binary itself, matching the
 * convention used by vm-pod.mjs's `exec` adapter.
 *
 * @param {JailerOptions} opts
 * @returns {string[]}
 */
export function buildJailerArgv(opts = {}) {
  const {
    id,
    execFile,
    uid,
    gid,
    chrootBaseDir = '/srv/jailer',
    netns,
    cgroups = [],
    cgroupVersion,
    parentCgroup,
    daemonize = false,
    newPidNs = false,
    jailerBin = 'jailer',
    firecrackerArgs = [],
  } = opts

  if (!id) throw new Error('jailer: id is required')
  if (!/^[0-9A-Za-z-]{1,64}$/.test(id)) {
    throw new Error(`jailer: id "${id}" must match ^[0-9A-Za-z-]{1,64}$`)
  }
  if (!execFile) throw new Error('jailer: execFile is required')
  if (uid === undefined || uid === null) throw new Error('jailer: uid is required')
  if (gid === undefined || gid === null) throw new Error('jailer: gid is required')
  // The jailer exists to drop the VMM to an unprivileged identity before it
  // runs guest-facing code; dropping "to" root would defeat that.
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('jailer: uid must be a non-zero integer')
  if (!Number.isInteger(gid) || gid <= 0) throw new Error('jailer: gid must be a non-zero integer')

  const argv = [
    jailerBin,
    '--id', id,
    '--exec-file', execFile,
    '--uid', String(uid),
    '--gid', String(gid),
    '--chroot-base-dir', chrootBaseDir,
  ]

  if (cgroupVersion !== undefined) argv.push('--cgroup-version', String(cgroupVersion))
  for (const c of cgroups) argv.push('--cgroup', c)
  if (parentCgroup !== undefined) argv.push('--parent-cgroup', parentCgroup)
  if (netns !== undefined) argv.push('--netns', netns)
  if (daemonize) argv.push('--daemonize')
  if (newPidNs) argv.push('--new-pid-ns')
  if (firecrackerArgs.length > 0) argv.push('--', ...firecrackerArgs)

  return argv
}

/**
 * Compute the host-visible path of a jailed microVM's Firecracker API
 * socket.
 *
 * jailer builds the chroot at `<chrootBaseDir>/<basename(execFile)>/<id>/root`
 * and `firecracker` itself listens on a socket at `/run/firecracker.socket`
 * *inside* that chroot by default (overridable with `--api-sock`, passed
 * through `firecrackerArgs` in {@link buildJailerArgv}). So from the
 * host's point of view the socket is at
 * `<chrootBaseDir>/<basename(execFile)>/<id>/root/run/firecracker.socket`.
 *
 * @param {object} opts
 * @param {string} opts.execFile - same value passed to buildJailerArgv
 * @param {string} opts.id - same value passed to buildJailerArgv
 * @param {string} [opts.chrootBaseDir='/srv/jailer']
 * @param {string} [opts.apiSockRelPath='run/firecracker.socket'] - path of
 *   the API socket relative to the jail root, matching `--api-sock` if
 *   overridden (minus any leading `/`)
 * @returns {string}
 */
export function jailerApiSocketPath(opts = {}) {
  const {
    execFile,
    id,
    chrootBaseDir = '/srv/jailer',
    apiSockRelPath = 'run/firecracker.socket',
  } = opts

  if (!execFile) throw new Error('jailerApiSocketPath: execFile is required')
  if (!id) throw new Error('jailerApiSocketPath: id is required')

  const execFileName = execFile.split('/').filter(Boolean).pop()
  const base = chrootBaseDir.replace(/\/+$/, '')
  const rel = apiSockRelPath.replace(/^\/+/, '')
  return `${base}/${execFileName}/${id}/root/${rel}`
}

/**
 * The jail's `root` directory as the host sees it: what Firecracker sees as
 * `/`. Every file the VMM is given lives under it.
 *
 * @param {{execFile: string, id: string, chrootBaseDir?: string}} opts
 * @returns {string}
 */
export function jailerRootPath({ execFile, id, chrootBaseDir = '/srv/jailer' } = {}) {
  if (!execFile) throw new Error('jailerRootPath: execFile is required')
  if (!id) throw new Error('jailerRootPath: id is required')
  const execFileName = execFile.split('/').filter(Boolean).pop()
  return `${chrootBaseDir.replace(/\/+$/, '')}/${execFileName}/${id}/root`
}

/**
 * Where a daemonized jailer records the VMM's process id: `<exec file
 * name>.pid` next to the chroot's `root`. NOT verified against a real
 * jailer (this module has never run one); `test:real-firecracker` is where
 * that gets checked.
 *
 * @param {{execFile: string, id: string, chrootBaseDir?: string}} opts
 * @returns {string}
 */
export function jailerPidFilePath({ execFile, id, chrootBaseDir = '/srv/jailer' } = {}) {
  if (!execFile) throw new Error('jailerPidFilePath: execFile is required')
  if (!id) throw new Error('jailerPidFilePath: id is required')
  const execFileName = execFile.split('/').filter(Boolean).pop()
  const base = chrootBaseDir.replace(/\/+$/, '')
  return `${base}/${execFileName}/${id}/root/${execFileName}.pid`
}

/**
 * Whether a `/proc/<pid>/cmdline` value (NUL-separated) is the VMM started
 * for exactly this pod id: an argument `--id` immediately followed by the id
 * (or the single argument `--id=<id>`), compared for equality. A pid file
 * can go stale and its pid be reused, so a process is only stopped when this
 * says it is ours, and an id that is a prefix or suffix of another pod's id
 * never matches that pod.
 *
 * @param {string} cmdline
 * @param {string} id
 * @returns {boolean}
 */
export function vmmCommandLineMatches(cmdline, id) {
  if (typeof cmdline !== 'string' || !cmdline || !id) return false
  const args = cmdline.split('\0')
  if (args.at(-1) === '') args.pop()
  // Only the VMM's own arguments count, never a later value of some other flag.
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === `--id=${id}`) return true
    if (args[i] === '--id') return args[i + 1] === id
  }
  return false
}
