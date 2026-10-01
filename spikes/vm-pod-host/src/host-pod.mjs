/**
 * host-pod.mjs — `VmPodHost`, a `Pod` subclass that runs on the physical
 * machine (the "vm-pod host agent" in issue #185 §5.2) and manages a set
 * of Firecracker microVM pods.
 *
 * `VmPodHost` is itself a pod in the mesh (issue #185 §3: "the host is
 * itself a pod"), using the exact same `Pod` base class and boot
 * sequence as a browser tab or `ServerPod` — see
 * `browsermesh-servers/kernel/server-pod.mjs` for the pattern this
 * mirrors. It advertises `runtimeClasses: ['microvm']` and
 * `shellBackend: 'vm-console'` so the orchestrator's
 * `runtimePeerToComputeDescriptor()` (packages/browsermesh-apps/src/orchestrator.mjs)
 * can route `execOnPod`/placement requests here.
 *
 * `Pod` itself has no `metadata` concept — `metadata` is a convention
 * read by the orchestrator off whatever the transport/discovery layer
 * reports for a peer (`peer.metadata?.runtimeClasses`, `peer.shellBackend`).
 * This class exposes a `metadata` getter and folds it into `toJSON()` so
 * that convention has something to find once this host is wired into a
 * real discovery adapter — that wiring is out of scope for this spike.
 */

import { Pod, EventEmitterTransport, NullDiscovery } from '../../../packages/browsermesh-pod/src/index.mjs'
import { VmPod } from './vm-pod.mjs'
import { FirecrackerClient } from './firecracker-client.mjs'
import { connectToGuest } from './vsock-bridge.mjs'
import { buildJailerArgv, jailerApiSocketPath } from './jailer.mjs'

/** Metadata this host advertises to the orchestrator (issue #185 §3, §6). */
const METADATA = Object.freeze({
  runtimeClasses: ['microvm'],
  shellBackend: 'vm-console',
  deploymentSupport: { canDeploy: true },
})

/** vsock port the guest's tiny exec responder listens on (see guest/init). */
const EXEC_VSOCK_PORT = 52

export class VmPodHost extends Pod {
  /** @type {Map<string, VmPod>} */
  #vms = new Map()
  #exec
  #dryRun
  #jailerOpts
  #onLog

  /**
   * @param {object} [opts]
   * @param {(argv: string[]) => Promise<{stdout: string, stderr: string, code: number}>} [opts.exec]
   *   Host command runner, forwarded to every `VmPod` this host spawns.
   *   Defaults to a stub that throws — pass a real one (e.g. wrapping
   *   `node:child_process.execFile`) to actually run commands, or rely
   *   on `dryRun` to never need one.
   * @param {boolean} [opts.dryRun=false] - default dryRun for spawned VmPods
   * @param {object} [opts.jailer] - default jailer options (uid, gid,
   *   chrootBaseDir, netns, cgroups) merged into each `spawn()` call
   * @param {(msg: string) => void} [opts.onLog]
   */
  constructor(opts = {}) {
    super()
    this.#exec = opts.exec ?? (async (argv) => {
      throw new Error(`VmPodHost: no exec() provided, cannot run: ${argv.join(' ')}`)
    })
    this.#dryRun = opts.dryRun ?? false
    this.#jailerOpts = opts.jailer ?? null
    this.#onLog = opts.onLog ?? (() => {})
  }

  /** @returns {object} metadata this host advertises for placement */
  get metadata() { return METADATA }

  /** @returns {ReadonlyMap<string, VmPod>} */
  get vms() { return new Map(this.#vms) }

  /**
   * Boot this host's own Pod identity (mirrors
   * `ServerPod#start()` — EventEmitterTransport + NullDiscovery, no
   * browser globals needed).
   * @returns {Promise<void>}
   */
  async start() {
    const g = { addEventListener: () => {}, removeEventListener: () => {} }
    await this.boot({
      transport: new EventEmitterTransport(),
      discovery: new NullDiscovery(),
      globalThis: g,
      handshakeTimeout: 0,
      discoveryTimeout: 0,
    })
    this.#onLog(`[vm-pod-host] started: ${this.podId}`)
  }

  /**
   * Spawn a new microVM pod. Builds the jailer argv (if jailer options
   * are configured), the API socket path inside its chroot, a
   * `FirecrackerClient` for that socket, and a `VmPod` lifecycle wrapper,
   * then boots it.
   *
   * @param {string} name - local name for this VM (distinct from the
   *   guest's own podId, which isn't known until it registers)
   * @param {object} opts
   * @param {string} opts.kernelImage
   * @param {string} opts.rootfs
   * @param {{hostDevName: string, guestMac?: string}} opts.tap
   * @param {{guestCid: number, udsPath: string}} opts.vsock
   * @param {import('./vm-pod.mjs').VmPodLimits} opts.limits
   * @param {string} opts.snapshotDir
   * @param {number} [opts.idleTimeoutMs]
   * @param {string} [opts.execFile='/usr/bin/firecracker']
   * @param {string} [opts.socketPath] - override the computed jailer
   *   socket path (useful in tests, pointing at a fake server)
   * @param {boolean} [opts.dryRun] - overrides the host's default
   * @returns {Promise<VmPod>}
   */
  async spawn(name, opts = {}) {
    if (this.#vms.has(name)) throw new Error(`VmPodHost: "${name}" already spawned`)

    const execFile = opts.execFile ?? '/usr/bin/firecracker'
    const dryRun = opts.dryRun ?? this.#dryRun
    const jailerOpts = this.#jailerOpts ?? { uid: 0, gid: 0, chrootBaseDir: '/srv/jailer' }

    const socketPath = opts.socketPath ?? jailerApiSocketPath({
      execFile, id: name, chrootBaseDir: jailerOpts.chrootBaseDir,
    })

    // Record (but, per vm-pod.mjs's own dryRun handling, don't actually
    // spawn) the jailer invocation that would front this VM.
    const jailerArgv = buildJailerArgv({
      ...jailerOpts, id: name, execFile,
      firecrackerArgs: ['--api-sock', '/run/firecracker.socket'],
    })

    const client = new FirecrackerClient({ socketPath })
    const vmPod = new VmPod({
      client,
      exec: this.#exec,
      id: name,
      kernelImage: opts.kernelImage,
      rootfs: opts.rootfs,
      tap: opts.tap,
      vsock: opts.vsock,
      limits: opts.limits,
      idleTimeoutMs: opts.idleTimeoutMs,
      snapshotDir: opts.snapshotDir,
      dryRun,
    })

    // The jailer spawn is a host command like any other TAP/nft command —
    // route it through the same planned-commands ledger.
    vmPod.plannedCommands.push({ argv: jailerArgv, description: 'spawn jailer (fronting firecracker)' })
    if (!dryRun) await this.#exec(jailerArgv)

    this.#vms.set(name, vmPod)
    await vmPod.boot()
    this.#onLog(`[vm-pod-host] spawned ${name} (socket: ${socketPath})`)
    return vmPod
  }

  /**
   * Execute a shell command on a running guest over vsock, using the
   * tiny line protocol implemented by `guest/init`'s exec responder:
   * host writes `EXEC <base64 JSON argv>\n`, guest replies
   * `RESULT <base64 JSON {stdout,stderr,code}>\n`.
   *
   * In `dryRun` mode (or when the VmPod itself is dryRun), no real vsock
   * connection is attempted — the call is recorded and a stub result is
   * returned, matching the "planned, not executed" contract the rest of
   * this spike uses.
   *
   * @param {string} name
   * @param {string[]} command - argv to run inside the guest
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async exec(name, command) {
    const vmPod = this.#require(name)
    if (vmPod.state !== 'registered' && vmPod.state !== 'serving') {
      throw new Error(`VmPodHost: "${name}" is not reachable (state: ${vmPod.state})`)
    }

    if (vmPod.dryRun) {
      vmPod.plannedCommands.push({
        argv: ['vsock-exec', ...command],
        description: `planned vsock EXEC on ${name} (port ${EXEC_VSOCK_PORT})`,
      })
      return { stdout: '', stderr: '', code: 0 }
    }

    vmPod.beginServing()
    try {
      const { socket } = await connectToGuest({ udsPath: vmPod.vsockUdsPath ?? '', port: EXEC_VSOCK_PORT })
      const payload = Buffer.from(JSON.stringify(command)).toString('base64')
      return await new Promise((resolve, reject) => {
        let buf = ''
        socket.on('data', (chunk) => {
          buf += chunk.toString('utf8')
          const nl = buf.indexOf('\n')
          if (nl === -1) return
          const line = buf.slice(0, nl)
          const match = /^RESULT (.+)$/.exec(line)
          if (!match) { reject(new Error(`unexpected vsock exec response: ${line}`)); return }
          socket.end()
          resolve(JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')))
        })
        socket.on('error', reject)
        socket.write(`EXEC ${payload}\n`)
      })
    } finally {
      vmPod.endServing()
    }
  }

  /**
   * Pause + snapshot a running pod (`registered`/`paused` ->
   * `snapshotted`).
   * @param {string} name
   * @returns {Promise<void>}
   */
  async snapshot(name) {
    const vmPod = this.#require(name)
    if (vmPod.state === 'registered') await vmPod.pause()
    await vmPod.snapshot()
  }

  /**
   * Restore a snapshotted pod back to `restoring` (awaiting
   * re-registration).
   * @param {string} name
   * @returns {Promise<void>}
   */
  async restore(name) {
    const vmPod = this.#require(name)
    await vmPod.restore()
  }

  /**
   * Drain a pod: notify peers, kill the VMM, tear down host networking,
   * and forget it.
   * @param {string} name
   * @returns {Promise<void>}
   */
  async drain(name) {
    const vmPod = this.#require(name)
    await vmPod.drain()
    this.#vms.delete(name)
  }

  /** @returns {object} status summary for every tracked VM, keyed by name */
  status() {
    const out = {}
    for (const [name, vmPod] of this.#vms) {
      out[name] = { state: vmPod.state, podId: vmPod.podId, dryRun: vmPod.dryRun }
    }
    return out
  }

  /** @returns {object} */
  toJSON() {
    return { ...super.toJSON(), metadata: METADATA, vms: this.status() }
  }

  #require(name) {
    const vmPod = this.#vms.get(name)
    if (!vmPod) throw new Error(`VmPodHost: no VM named "${name}"`)
    return vmPod
  }
}
