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
   */
  constructor({
    client, exec, id, kernelImage, rootfs, tap, vsock, limits,
    idleTimeoutMs = 30_000, snapshotDir, dryRun = false,
  }) {
    super()
    if (!id) throw new Error('VmPod: id is required')
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
  }

  /** @returns {string} */
  get id() { return this.#id }

  /** @returns {string} */
  get state() { return this.#state }

  /** @returns {boolean} */
  get dryRun() { return this.#dryRun }

  /** @returns {string|null} podId of the guest ServerPod once registered */
  get podId() { return this.#podId }

  /** @returns {string|undefined} the vsock device's uds_path, for host-pod.mjs's exec() */
  get vsockUdsPath() { return this.#vsock?.udsPath }

  get snapshotVmStatePath() { return `${this.#snapshotDir}/${this.#id}.vmstate` }
  get snapshotMemPath() { return `${this.#snapshotDir}/${this.#id}.mem` }

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
    return this.#client[api](args)
  }

  /**
   * Run a planned host command: either execute it for real via `exec`,
   * or record it in `plannedCommands` when `dryRun`.
   * @param {string[]} argv
   * @param {string} [description]
   */
  async #runExec(argv, description) {
    if (this.#dryRun) {
      this.plannedCommands.push({ argv, description })
      return { stdout: '', stderr: '', code: 0 }
    }
    this.plannedCommands.push({ argv, description })
    return this.#exec(argv)
  }

  // ── Host-side network setup ──────────────────────────────────

  async #setUpTap() {
    const dev = this.#tap?.hostDevName ?? `tap-${this.#id}`
    await this.#runExec(['ip', 'tuntap', 'add', dev, 'mode', 'tap'], 'create TAP device')
    await this.#runExec(['ip', 'link', 'set', dev, 'up'], 'bring TAP device up')
    await this.#runExec(
      ['nft', 'add', 'rule', 'firecracker', 'filter', 'iifname', dev, 'oifname', 'eth0', 'accept'],
      'nftables: allow TAP -> uplink forwarding (masquerade)',
    )
  }

  async #tearDownTap() {
    const dev = this.#tap?.hostDevName ?? `tap-${this.#id}`
    await this.#runExec(['ip', 'link', 'set', dev, 'down'], 'bring TAP device down')
    await this.#runExec(['ip', 'tuntap', 'del', dev, 'mode', 'tap'], 'delete TAP device')
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

    await this.#setUpTap()

    await this.#callApi('putMachineConfig', {
      vcpu_count: this.#limits?.vcpus,
      mem_size_mib: this.#limits?.memMib,
      track_dirty_pages: true,
    })
    await this.#callApi('putBootSource', {
      kernel_image_path: this.#kernelImage,
      boot_args: 'console=ttyS0 reboot=k panic=1 root=/dev/vda rw',
    })
    await this.#callApi('putDrive', ['rootfs', {
      path_on_host: this.#rootfs,
      is_root_device: true,
      is_read_only: false,
      rate_limiter: this.#limits?.blockRateLimiter,
    }])
    await this.#callApi('putNetworkInterface', ['eth0', {
      host_dev_name: this.#tap?.hostDevName ?? `tap-${this.#id}`,
      guest_mac: this.#tap?.guestMac,
      rx_rate_limiter: this.#limits?.netRateLimiter,
      tx_rate_limiter: this.#limits?.netRateLimiter,
    }])
    await this.#callApi('putVsock', {
      guest_cid: this.#vsock?.guestCid,
      uds_path: this.#vsock?.udsPath,
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
      snapshot_path: this.snapshotVmStatePath,
      mem_file_path: this.snapshotMemPath,
      snapshot_type: 'Full',
    })
    await this.#runExec(
      ['pkill', '-f', `--id ${this.#id}`],
      'kill the jailed firecracker/jailer process for this VM',
    )
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
    await this.#setUpTap()
    await this.#callApi('loadSnapshot', {
      snapshot_path: this.snapshotVmStatePath,
      mem_backend: { backend_type: 'File', backend_path: this.snapshotMemPath },
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
    await this.#runExec(
      ['pkill', '-f', `--id ${this.#id}`],
      'kill the jailed firecracker/jailer process for this VM',
    )
    await this.#tearDownTap()
    this.#transition('cold', 'drain complete, rootfs kept')
  }
}
