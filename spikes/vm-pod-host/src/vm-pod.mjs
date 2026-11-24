/**
 * vm-pod.mjs — lifecycle state machine for a single Firecracker-hosted
 * microVM pod, as specified in browsermesh issue #185 §5.3:
 *
 *   cold -> booting -> registered -> serving -> registered
 *   registered -> paused -> snapshotted -> restoring -> registered
 *   registered -> draining -> cold
 *
 * `VmPod` owns the *orchestration* of one microVM: it drives a
 * `FirecrackerClient` through the pre-boot configuration + InstanceStart
 * sequence, and drives an injectable `exec(argv)` through the host-side
 * setup commands (TAP device, nftables masquerade, jailer invocation,
 * process teardown) that happen outside the Firecracker API.
 *
 * Two independent execution modes, both always available on every
 * instance:
 *
 *   - `dryRun: true` — nothing is actually called. Every planned
 *     Firecracker API call is pushed to `plannedApiCalls` and every
 *     planned host command is pushed to `plannedCommands`, in the exact
 *     order they would have run. This is what runs on macOS/CI, where
 *     there is neither `/dev/kvm` nor a real Firecracker socket.
 *   - `dryRun: false` — API calls go through the real `client` (e.g.
 *     against the fake Firecracker server in test/, or a real
 *     Firecracker socket on a Linux+KVM host) and host commands go
 *     through the real `exec` function.
 *
 * `VmPod` is an EventEmitter; it emits `'transition'` with
 * `{ from, to, reason }` for every state change, plus a same-named
 * convenience event per target state (e.g. `'registered'`, `'paused'`).
 */

import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { buildNetworkPlan, allocateSubnet, tapDeviceName } from './network-policy.mjs'
import { buildBootArgs, chrootLayout, planChrootStaging } from './vm-config.mjs'
import { vmmCommandLineMatches } from './jailer.mjs'

/** Valid state machine states, matching issue #185 §5.3 exactly. */
export const STATES = Object.freeze([
  'cold', 'booting', 'registered', 'serving',
  'paused', 'snapshotted', 'restoring', 'draining',
])

/**
 * Allowed transitions, `from -> Set<to>`. `markRegistered()` is valid
 * from both `booting` (cold boot) and `restoring` (snapshot restore),
 * matching the two incoming arrows into `Registered` in the issue's
 * state diagram.
 */
const TRANSITIONS = {
  cold: new Set(['booting']),
  booting: new Set(['registered']),
  registered: new Set(['serving', 'paused', 'draining']),
  serving: new Set(['registered']),
  paused: new Set(['snapshotted']),
  snapshotted: new Set(['restoring']),
  restoring: new Set(['registered']),
  draining: new Set(['cold']),
}

/** Thrown when an invalid state transition is attempted. */
export class VmPodStateError extends Error {
  constructor(from, to) {
    super(`VmPod: invalid transition ${from} -> ${to}`)
    this.name = 'VmPodStateError'
    this.from = from
    this.to = to
  }
}

/**
 * @typedef {object} VmPodLimits
 * @property {number} vcpus
 * @property {number} memMib
 * @property {import('./firecracker-client.mjs').RateLimiter} [netRateLimiter]
 * @property {import('./firecracker-client.mjs').RateLimiter} [blockRateLimiter]
 */

export class VmPod extends EventEmitter {
  #client
  #exec
  #id
  #kernelImage
  #rootfs
  #tap
  #vsock
  #limits
  #idleTimeoutMs
  #snapshotDir
  #dryRun
  #vmmArgv
  #vmmPidFile
  #jail
  #layout = null
  #signalingUrl
  #rootfsBase
  #network
  #proc
  #state = 'cold'
  #idleTimer = null
  #podId = null

  /** @type {Array<{api: string, args: *}>} */
  plannedApiCalls = []
  /** @type {Array<{argv: string[], description?: string}>} */
  plannedCommands = []

  /**
   * @param {object} opts
   * @param {import('./firecracker-client.mjs').FirecrackerClient} opts.client
   * @param {(argv: string[]) => Promise<{stdout: string, stderr: string, code: number}>} opts.exec
   * @param {string} opts.id - unique VM id (also the jailer `--id`)
   * @param {string} opts.kernelImage - path to vmlinux on the host
   * @param {string} opts.rootfs - path to the rootfs.ext4 image on the host
   * @param {{hostDevName: string, guestMac?: string}} opts.tap
   * @param {{guestCid: number, udsPath: string}} opts.vsock
   * @param {VmPodLimits} opts.limits
   * @param {number} [opts.idleTimeoutMs=30000] - time in `registered` with
   *   no `serving` activity before auto-pause
   * @param {string} opts.snapshotDir - directory to write
   *   `<id>.vmstate` / `<id>.mem` snapshot files into
   * @param {boolean} [opts.dryRun=false]
   * @param {string[]} [opts.vmmArgv] - argv (e.g. from `buildJailerArgv()`,
   *   daemonized) that starts a fresh Firecracker process whose API socket
   *   `client` talks to. Run at the start of `boot()` and in `restore()`
   *   (`snapshot()` kills the VMM, so a restore needs a new one). Omit when
   *   the host starts the VMM itself, as before.
   * @param {string} [opts.vmmPidFile] - File the daemonized VMM's pid is
   *   written to (see `jailerPidFilePath()`). Needed to stop the VMM
   *   (`snapshot()`, `drain()`): the VMM is stopped by pid, only after its
   *   command line is checked to carry exactly this pod's `--id`.
   * @param {string} [opts.rootfsBase] - A shared, read-only base image.
   *   `rootfs` is then this pod's OWN copy, made once before first boot
   *   (never overwritten afterwards, so a drained pod keeps its disk). The
   *   base image is never attached to a VM, because two pods writing one
   *   disk image can read and corrupt each other's data.
   * @param {{hostIp?: string, guestIp?: string, uplink?: string, egress?: object}} [opts.network]
   *   Passed to `buildNetworkPlan()`. Defaults to the `/30` for this VM's
   *   vsock CID, the default egress policy (public addresses only) and `eth0`.
   * @param {{readFile?: Function, kill?: Function}} [opts.proc] - Process
   *   table access, injectable for tests.
   * @param {{root: string, uid: number, gid: number}} [opts.jail] - Run
   *   under the jailer: `root` is the chroot's `root` directory on the host.
   *   Firecracker then sees every file by a name relative to the jail
   *   (`chrootLayout()`), and `boot()` stages the kernel and a private copy
   *   of `rootfsBase` inside it, owned by `uid:gid`. `rootfs` and
   *   `snapshotDir` are not used in this mode.
   * @param {string} [opts.signalingUrl] - Handed to the guest on its kernel
   *   command line (`buildBootArgs()`); no credentials.
   */
  constructor({
    client, exec, id, kernelImage, rootfs, tap, vsock, limits,
    idleTimeoutMs = 30_000, snapshotDir, dryRun = false, vmmArgv,
    vmmPidFile, rootfsBase, network, proc, jail, signalingUrl,
  }) {
    super()
    if (!id) throw new Error('VmPod: id is required')
    if (rootfsBase !== undefined && rootfsBase === rootfs) {
      throw new Error('VmPod: rootfs must be this pod\'s own copy, not the shared base image')
    }
    if (jail) {
      if (!Number.isInteger(jail.uid) || jail.uid <= 0) throw new Error('VmPod: jail.uid must be a non-zero integer')
      if (!Number.isInteger(jail.gid) || jail.gid <= 0) throw new Error('VmPod: jail.gid must be a non-zero integer')
      if (!rootfsBase) throw new Error('VmPod: a jailed VM needs rootfsBase (the image its private copy is made from)')
      this.#layout = chrootLayout({ root: jail.root })
    }
    this.#jail = jail ?? null
    this.#signalingUrl = signalingUrl
    this.#vmmPidFile = vmmPidFile
    this.#rootfsBase = rootfsBase
    this.#network = network ?? {}
    this.#proc = {
      readFile: proc?.readFile ?? ((path) => readFile(path, 'utf8')),
      kill: proc?.kill ?? ((pid, signal) => process.kill(pid, signal)),
    }
    this.#client = client
    this.#exec = exec
    this.#id = id
    this.#kernelImage = kernelImage
    this.#rootfs = rootfs
    this.#tap = tap
    this.#vsock = vsock
    this.#limits = limits
    this.#idleTimeoutMs = idleTimeoutMs
    this.#snapshotDir = snapshotDir
    this.#dryRun = dryRun
    this.#vmmArgv = vmmArgv
  }

  /** @returns {string} */
  get id() { return this.#id }

  /** @returns {string} */
  get state() { return this.#state }

  /** @returns {boolean} */
  get dryRun() { return this.#dryRun }

  /** @returns {string|null} podId of the guest ServerPod once registered */
  get podId() { return this.#podId }

  /** @returns {string|undefined} the vsock socket on the HOST, for host-pod.mjs's exec() */
  get vsockUdsPath() { return this.#layout ? this.#layout.host.vsock : this.#vsock?.udsPath }

  /** Snapshot files as the host sees them. */
  get snapshotVmStatePath() { return this.#layout ? this.#layout.host.vmstate : `${this.#snapshotDir}/${this.#id}.vmstate` }
  get snapshotMemPath() { return this.#layout ? this.#layout.host.mem : `${this.#snapshotDir}/${this.#id}.mem` }

  /** The names Firecracker is given: relative to the jail when jailed. */
  get #apiPaths() {
    return this.#layout
      ? this.#layout.api
      : {
        kernel: this.#kernelImage,
        rootfs: this.#rootfs,
        vsock: this.#vsock?.udsPath,
        vmstate: this.snapshotVmStatePath,
        mem: this.snapshotMemPath,
      }
  }

  // ── State machine core ──────────────────────────────────────

  /**
   * @param {string} to
   * @param {string} [reason]
   */
  #transition(to, reason) {
    const allowed = TRANSITIONS[this.#state]
    if (!allowed || !allowed.has(to)) {
      throw new VmPodStateError(this.#state, to)
    }
    const from = this.#state
    this.#state = to
    this.emit('transition', { from, to, reason })
    this.emit(to, { from, reason })
  }

  /**
   * Run a planned Firecracker API call: either execute it for real via
   * `client`, or record it in `plannedApiCalls` when `dryRun`.
   * @param {string} api - method name on FirecrackerClient
   * @param {*} args
   */
  async #callApi(api, args) {
    if (this.#dryRun) {
      this.plannedApiCalls.push({ api, args })
      return undefined
    }
    this.plannedApiCalls.push({ api, args })
    // `putDrive(id, opts)` and `putNetworkInterface(id, opts)` take two
    // arguments; their planned form is the pair, so spread it.
    return Array.isArray(args) ? this.#client[api](...args) : this.#client[api](args)
  }

  /**
   * Run a planned host command: either execute it for real via `exec`,
   * or record it in `plannedCommands` when `dryRun`.
   * @param {string[]} argv
   * @param {string} [description]
   */
  async #runExec(argv, description, { tolerateFailure = false } = {}) {
    if (this.#dryRun) {
      this.plannedCommands.push({ argv, description })
      return { stdout: '', stderr: '', code: 0 }
    }
    this.plannedCommands.push({ argv, description })
    const result = await this.#exec(argv)
    // A host command that fails must stop the sequence: carrying on after
    // the network rules failed to install would start a VM with no policy.
    if (!tolerateFailure && result && typeof result.code === 'number' && result.code !== 0) {
      throw new Error(`VmPod: host command failed (exit ${result.code}): ${argv.join(' ')}${result.stderr ? `: ${result.stderr}` : ''}`)
    }
    return result
  }

  /** Start a fresh Firecracker process, when the host asked this pod to own that. */
  async #startVmm() {
    if (!this.#vmmArgv) return
    await this.#runExec(this.#vmmArgv, 'start a fresh jailed firecracker process')
  }

  // ── Host-side network setup ──────────────────────────────────

  /** The `/30` for this VM: the network option's addresses, else the one for its vsock CID. */
  #addresses() {
    const subnet = allocateSubnet(Math.max(0, (this.#vsock?.guestCid ?? 3) - 3))
    return {
      hostIp: this.#network.hostIp ?? subnet.hostIp,
      guestIp: this.#network.guestIp ?? subnet.guestIp,
      netmask: subnet.netmask,
    }
  }

  /** @returns {string} The guest kernel command line. */
  #bootArgs() {
    const { hostIp, guestIp, netmask } = this.#addresses()
    return buildBootArgs({ guestIp, gatewayIp: hostIp, netmask, signalingUrl: this.#signalingUrl })
  }

  /** Put the kernel and a private rootfs copy inside the jail. */
  async #stageJail() {
    const steps = planChrootStaging({
      root: this.#jail.root,
      kernelSrc: this.#kernelImage,
      rootfsSrc: this.#rootfsBase,
      uid: this.#jail.uid,
      gid: this.#jail.gid,
    })
    for (const argv of steps) await this.#runExec(argv, `stage the jail: ${argv[0]}`)
  }

  /** @returns {ReturnType<typeof buildNetworkPlan>} */
  #networkPlan() {
    const { hostIp, guestIp } = this.#addresses()
    return buildNetworkPlan({
      id: this.#id,
      tapDev: this.#tap?.hostDevName ?? tapDeviceName(this.#id),
      guestMac: this.#tap?.guestMac,
      hostIp,
      guestIp,
      uplink: this.#network.uplink,
      egress: this.#network.egress,
    })
  }

  async #setUpTap() {
    for (const argv of this.#networkPlan().setup) {
      await this.#runExec(argv, `network: ${argv.slice(0, 3).join(' ')}`)
    }
  }

  /** @param {{tolerateFailure?: boolean}} [opts] */
  async #tearDownTap({ tolerateFailure = false } = {}) {
    for (const argv of this.#networkPlan().teardown) {
      await this.#runExec(argv, `network: ${argv.slice(0, 3).join(' ')}`, { tolerateFailure })
    }
  }

  /**
   * Give the pod its own disk image from the shared base, once. `--no-clobber`
   * means a pod that is drained and booted again keeps what it wrote.
   */
  async #prepareRootfs() {
    if (!this.#rootfsBase) return
    const dir = this.#rootfs.slice(0, this.#rootfs.lastIndexOf('/')) || '/'
    await this.#runExec(['mkdir', '-p', '--', dir], 'create the pod\'s own directory')
    await this.#runExec(
      ['cp', '--reflink=auto', '--no-clobber', '--', this.#rootfsBase, this.#rootfs],
      'give the pod its own copy of the base image',
    )
  }

  /**
   * Stop this pod's VMM: by the pid it recorded, and only if that process
   * is still the VMM started for exactly this id.
   */
  async #killVmm() {
    if (!this.#vmmPidFile) {
      throw new Error('VmPod: vmmPidFile is required to stop the VMM')
    }
    if (this.#dryRun) {
      this.plannedCommands.push({ argv: ['kill-vmm', this.#vmmPidFile], description: 'stop this VM\'s VMM by its recorded pid' })
      return
    }
    this.plannedCommands.push({ argv: ['kill-vmm', this.#vmmPidFile], description: 'stop this VM\'s VMM by its recorded pid' })
    const raw = String(await this.#proc.readFile(this.#vmmPidFile)).trim()
    if (!/^\d+$/.test(raw) || Number(raw) <= 1) {
      throw new Error(`VmPod: pid file ${this.#vmmPidFile} does not hold a process id`)
    }
    const pid = Number(raw)
    let cmdline = ''
    try {
      cmdline = String(await this.#proc.readFile(`/proc/${pid}/cmdline`))
    } catch {
      // The process is already gone: nothing to stop.
      return
    }
    if (!vmmCommandLineMatches(cmdline, this.#id)) {
      throw new Error(`VmPod: process ${pid} does not belong to VM ${this.#id}; not stopping it`)
    }
    this.#proc.kill(pid, 'SIGTERM')
  }

  // ── Lifecycle: cold -> booting -> registered ─────────────────

  /**
   * Cold boot: host network setup, full Firecracker pre-boot
   * configuration, InstanceStart. Leaves the pod in `booting` — it only
   * reaches `registered` once {@link markRegistered} is called (the
   * guest's `ServerPod` announcing itself, via vsock hello or the
   * signaling server).
   * @returns {Promise<void>}
   */
  async boot() {
    this.#transition('booting', 'boot() called')

    if (!this.#jail) await this.#prepareRootfs()
    await this.#startVmm()
    // The jailer builds the chroot when it starts, so its files go in after.
    if (this.#jail) await this.#stageJail()
    await this.#setUpTap()

    const api = this.#apiPaths
    await this.#callApi('putMachineConfig', {
      vcpu_count: this.#limits?.vcpus,
      mem_size_mib: this.#limits?.memMib,
      track_dirty_pages: true,
    })
    await this.#callApi('putBootSource', {
      kernel_image_path: api.kernel,
      boot_args: this.#bootArgs(),
    })
    await this.#callApi('putDrive', ['rootfs', {
      path_on_host: api.rootfs,
      is_root_device: true,
      is_read_only: false,
      rate_limiter: this.#limits?.blockRateLimiter,
    }])
    await this.#callApi('putNetworkInterface', ['eth0', {
      host_dev_name: this.#tap?.hostDevName ?? tapDeviceName(this.#id),
      guest_mac: this.#tap?.guestMac,
      rx_rate_limiter: this.#limits?.netRateLimiter,
      tx_rate_limiter: this.#limits?.netRateLimiter,
    }])
    await this.#callApi('putVsock', {
      guest_cid: this.#vsock?.guestCid,
      uds_path: api.vsock,
    })
    await this.#callApi('start', undefined)
  }

  /**
   * Mark the pod registered — called when the guest's `ServerPod` shows
   * up in signaling, or when its vsock hello arrives. Valid from
   * `booting` (cold boot) or `restoring` (post-snapshot-load).
   * @param {string} podId - the guest ServerPod's podId
   */
  markRegistered(podId) {
    this.#podId = podId
    this.#transition('registered', 'guest registered')
    this.#scheduleIdleTimeout()
  }

  // ── Lifecycle: registered <-> serving ────────────────────────

  /** Begin serving a request (`registered` -> `serving`). */
  beginServing() {
    this.#clearIdleTimeout()
    this.#transition('serving', 'exec/message in flight')
  }

  /** Finish serving a request (`serving` -> `registered`). */
  endServing() {
    this.#transition('registered', 'exec/message complete')
    this.#scheduleIdleTimeout()
  }

  #scheduleIdleTimeout() {
    this.#clearIdleTimeout()
    if (!this.#idleTimeoutMs || this.#idleTimeoutMs <= 0) return
    this.#idleTimer = setTimeout(() => {
      this.pause().catch((err) => {
        // EventEmitter throws on an unhandled 'error' event — only emit
        // it if someone is actually listening, otherwise log and swallow
        // so a background idle-timeout failure can't crash the host.
        if (this.listenerCount('error') > 0) this.emit('error', err)
        else console.error('[vm-pod] idle-timeout auto-pause failed:', err)
      })
    }, this.#idleTimeoutMs)
    if (typeof this.#idleTimer.unref === 'function') this.#idleTimer.unref()
  }

  #clearIdleTimeout() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer)
      this.#idleTimer = null
    }
  }

  // ── Lifecycle: registered -> paused -> snapshotted ───────────

  /**
   * Pause the microVM's vCPUs (`registered` -> `paused`).
   * @returns {Promise<void>}
   */
  async pause() {
    this.#clearIdleTimeout()
    this.#transition('paused', 'idle timeout or explicit pause')
    await this.#callApi('pause', undefined)
  }

  /**
   * Snapshot a paused microVM to disk and kill the VMM process
   * (`paused` -> `snapshotted`). The rootfs file is left in place so a
   * later `restore()` can reuse it.
   * @returns {Promise<void>}
   */
  async snapshot() {
    await this.#callApi('createSnapshot', {
      snapshot_path: this.#apiPaths.vmstate,
      mem_file_path: this.#apiPaths.mem,
      snapshot_type: 'Full',
    })
    await this.#killVmm()
    this.#transition('snapshotted', 'snapshot/create complete, VMM killed')
  }

  // ── Lifecycle: snapshotted -> restoring -> registered ────────

  /**
   * Restore a snapshotted microVM: re-run host network setup, spawn a
   * fresh (pre-boot) Firecracker process, load the snapshot, and resume.
   * Leaves the pod in `restoring` until {@link markRegistered} fires
   * again (the guest re-announcing after resume).
   * @returns {Promise<void>}
   */
  async restore() {
    this.#transition('restoring', 'restore() called')
    // The TAP and its rules survive a snapshot unless the host restarted:
    // remove whatever is there (it may not exist) and install a fresh set.
    await this.#tearDownTap({ tolerateFailure: true })
    await this.#setUpTap()
    // snapshot() killed the VMM, which left its vsock UDS behind; loadSnapshot
    // fails with "Address already in use" if it is still there.
    if (this.vsockUdsPath) {
      await this.#runExec(['rm', '-f', this.vsockUdsPath], 'unlink the stale vsock socket left by the killed VMM')
    }
    await this.#startVmm()
    await this.#callApi('loadSnapshot', {
      snapshot_path: this.#apiPaths.vmstate,
      mem_backend: { backend_type: 'File', backend_path: this.#apiPaths.mem },
      resume_vm: false,
    })
    await this.#callApi('resume', undefined)
  }

  // ── Lifecycle: registered -> draining -> cold ────────────────

  /**
   * Drain the pod: notify peers, kill the VMM (if still running), tear
   * down host networking, and return to `cold` — the rootfs image is
   * kept so the pod can be re-booted later.
   * @returns {Promise<void>}
   */
  async drain() {
    this.#clearIdleTimeout()
    this.#transition('draining', 'drain() called')
    this.emit('drain:peers-notified', { id: this.#id, podId: this.#podId })
    await this.#killVmm()
    await this.#tearDownTap()
    this.#transition('cold', 'drain complete, rootfs kept')
  }
}
