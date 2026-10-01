/**
 * firecracker-client.mjs — Thin HTTP-over-unix-socket client for the
 * Firecracker VMM REST API.
 *
 * Endpoint paths, request bodies and field names below were verified
 * against `src/firecracker/swagger/firecracker.yaml` on the Firecracker
 * `main` branch (fetched 2026-09-30). Firecracker's control plane is a
 * REST API served over a Unix domain socket (one per microVM); there is
 * no TCP listener and no auth beyond "can you open the socket file".
 *
 * Firecracker returns:
 *   - `204 No Content` for successful PUT/PATCH actions (no body)
 *   - `200 OK` with a JSON body for GET
 *   - `400 Bad Request` with `{ "fault_message": "..." }` for malformed
 *     or out-of-order requests (e.g. mutating boot-source after start)
 *
 * This client is pure Node (`node:http` with `socketPath`) and zero
 * third-party dependencies, so it runs identically on macOS (against the
 * fake server in test/fake-firecracker-server.mjs) and on a real Linux +
 * KVM host (against the real `firecracker` process's API socket).
 */

import http from 'node:http'

/**
 * Error raised for any Firecracker API response with status >= 400.
 * Carries the HTTP status and, when present, Firecracker's own
 * `fault_message` field so callers can log/triage without re-parsing
 * the response body.
 */
export class FirecrackerApiError extends Error {
  /**
   * @param {object} opts
   * @param {string} opts.method
   * @param {string} opts.path
   * @param {number} opts.status
   * @param {string} [opts.faultMessage]
   * @param {*} [opts.body] - raw parsed response body, if any
   */
  constructor({ method, path, status, faultMessage, body }) {
    super(`Firecracker API ${method} ${path} -> ${status}${faultMessage ? `: ${faultMessage}` : ''}`)
    this.name = 'FirecrackerApiError'
    this.method = method
    this.path = path
    this.status = status
    this.faultMessage = faultMessage ?? null
    this.body = body ?? null
  }
}

/**
 * @typedef {object} TokenBucket
 * @property {number} size - Token bucket size (bytes or ops), required
 * @property {number} refill_time - Milliseconds to refill the bucket, required
 * @property {number} [one_time_burst] - Initial burst size
 */

/**
 * @typedef {object} RateLimiter
 * @property {TokenBucket} [bandwidth]
 * @property {TokenBucket} [ops]
 */

/**
 * Client for a single microVM's Firecracker API socket.
 *
 * One instance per microVM (one API socket per microVM — this is how
 * Firecracker itself is scoped; there is no multi-VM control plane).
 */
export class FirecrackerClient {
  #socketPath

  /**
   * @param {object} opts
   * @param {string} opts.socketPath - Path to the microVM's Firecracker API
   *   unix socket (inside the jailer chroot when jailed — see jailer.mjs).
   */
  constructor({ socketPath }) {
    if (!socketPath) throw new Error('socketPath is required')
    this.#socketPath = socketPath
  }

  /** @returns {string} */
  get socketPath() { return this.#socketPath }

  /**
   * Low-level request helper. Not part of the public per-endpoint API but
   * exported implicitly via the methods below.
   *
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @returns {Promise<{status: number, body: *}>}
   */
  async #request(method, path, body) {
    const payload = body === undefined ? null : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = http.request({
        socketPath: this.#socketPath,
        path,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let parsed = null
          if (raw.length > 0) {
            try { parsed = JSON.parse(raw) } catch { parsed = raw }
          }
          const status = res.statusCode ?? 0
          if (status >= 400) {
            const faultMessage = parsed && typeof parsed === 'object' ? parsed.fault_message : undefined
            reject(new FirecrackerApiError({ method, path, status, faultMessage, body: parsed }))
            return
          }
          resolve({ status, body: parsed })
        })
      })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  // ── Pre-boot configuration ────────────────────────────────────

  /**
   * PUT /machine-config — vCPU count, memory size, SMT, CPU template.
   * @param {object} opts
   * @param {number} opts.vcpu_count
   * @param {number} opts.mem_size_mib
   * @param {boolean} [opts.smt]
   * @param {string} [opts.cpu_template]
   * @param {boolean} [opts.track_dirty_pages] - required when a snapshot
   *   will later be taken of this microVM
   * @returns {Promise<void>}
   */
  async putMachineConfig({ vcpu_count, mem_size_mib, smt, cpu_template, track_dirty_pages } = {}) {
    const body = { vcpu_count, mem_size_mib }
    if (smt !== undefined) body.smt = smt
    if (cpu_template !== undefined) body.cpu_template = cpu_template
    if (track_dirty_pages !== undefined) body.track_dirty_pages = track_dirty_pages
    await this.#request('PUT', '/machine-config', body)
  }

  /** GET /machine-config @returns {Promise<object>} */
  async getMachineConfig() {
    const { body } = await this.#request('GET', '/machine-config')
    return body
  }

  /**
   * PUT /boot-source — guest kernel image, cmdline, optional initrd.
   * @param {object} opts
   * @param {string} opts.kernel_image_path
   * @param {string} [opts.boot_args]
   * @param {string} [opts.initrd_path]
   * @returns {Promise<void>}
   */
  async putBootSource({ kernel_image_path, boot_args, initrd_path } = {}) {
    const body = { kernel_image_path }
    if (boot_args !== undefined) body.boot_args = boot_args
    if (initrd_path !== undefined) body.initrd_path = initrd_path
    await this.#request('PUT', '/boot-source', body)
  }

  /**
   * PUT /drives/{id} — attach a virtio-block drive (root device or a
   * secondary data volume).
   * @param {string} id - drive_id, also used as the path segment
   * @param {object} opts
   * @param {string} opts.path_on_host
   * @param {boolean} opts.is_root_device
   * @param {boolean} [opts.is_read_only]
   * @param {RateLimiter} [opts.rate_limiter]
   * @returns {Promise<void>}
   */
  async putDrive(id, { path_on_host, is_root_device, is_read_only, rate_limiter } = {}) {
    if (!id) throw new Error('drive id is required')
    const body = { drive_id: id, path_on_host, is_root_device }
    if (is_read_only !== undefined) body.is_read_only = is_read_only
    if (rate_limiter !== undefined) body.rate_limiter = rate_limiter
    await this.#request('PUT', `/drives/${encodeURIComponent(id)}`, body)
  }

  /**
   * PUT /network-interfaces/{id} — attach a virtio-net interface backed
   * by a host TAP device.
   * @param {string} id - iface_id, also used as the path segment
   * @param {object} opts
   * @param {string} opts.host_dev_name - host TAP device name
   * @param {string} [opts.guest_mac]
   * @param {RateLimiter} [opts.rx_rate_limiter]
   * @param {RateLimiter} [opts.tx_rate_limiter]
   * @returns {Promise<void>}
   */
  async putNetworkInterface(id, { host_dev_name, guest_mac, rx_rate_limiter, tx_rate_limiter } = {}) {
    if (!id) throw new Error('network interface id is required')
    const body = { iface_id: id, host_dev_name }
    if (guest_mac !== undefined) body.guest_mac = guest_mac
    if (rx_rate_limiter !== undefined) body.rx_rate_limiter = rx_rate_limiter
    if (tx_rate_limiter !== undefined) body.tx_rate_limiter = tx_rate_limiter
    await this.#request('PUT', `/network-interfaces/${encodeURIComponent(id)}`, body)
  }

  /**
   * PUT /vsock — attach a single vsock device. Firecracker supports at
   * most one vsock device per microVM, with a fixed `uds_path` the host
   * connects to / listens on (see vsock-bridge.mjs).
   * @param {object} opts
   * @param {number} opts.guest_cid - must be >= 3
   * @param {string} opts.uds_path
   * @returns {Promise<void>}
   */
  async putVsock({ guest_cid, uds_path } = {}) {
    await this.#request('PUT', '/vsock', { guest_cid, uds_path })
  }

  // ── Lifecycle actions ─────────────────────────────────────────

  /**
   * PUT /actions {action_type: InstanceStart} — boot the configured
   * microVM. Only valid once in the pre-boot state.
   * @returns {Promise<void>}
   */
  async start() {
    await this.#request('PUT', '/actions', { action_type: 'InstanceStart' })
  }

  /**
   * PUT /actions {action_type: SendCtrlAltDel} — ask the guest to shut
   * down gracefully (x86_64 only; Firecracker rejects this on aarch64).
   * @returns {Promise<void>}
   */
  async sendCtrlAltDel() {
    await this.#request('PUT', '/actions', { action_type: 'SendCtrlAltDel' })
  }

  /**
   * PATCH /vm {state: 'Paused'} — pause vCPUs. Required before
   * `createSnapshot`.
   * @returns {Promise<void>}
   */
  async pause() {
    await this.#request('PATCH', '/vm', { state: 'Paused' })
  }

  /**
   * PATCH /vm {state: 'Resumed'} — resume vCPUs after pause or snapshot
   * load.
   * @returns {Promise<void>}
   */
  async resume() {
    await this.#request('PATCH', '/vm', { state: 'Resumed' })
  }

  // ── Snapshotting ───────────────────────────────────────────────

  /**
   * PUT /snapshot/create — snapshot a paused microVM to disk. Requires
   * the microVM to be in the `Paused` state and, for a usable restore,
   * `track_dirty_pages: true` to have been set in `putMachineConfig`.
   * @param {object} opts
   * @param {string} opts.snapshot_path - where to write VM state
   * @param {string} opts.mem_file_path - where to write guest memory
   * @param {'Full'|'Diff'} [opts.snapshot_type]
   * @returns {Promise<void>}
   */
  async createSnapshot({ snapshot_path, mem_file_path, snapshot_type } = {}) {
    const body = { snapshot_path, mem_file_path }
    if (snapshot_type !== undefined) body.snapshot_type = snapshot_type
    await this.#request('PUT', '/snapshot/create', body)
  }

  /**
   * PUT /snapshot/load — load a previously created snapshot into a
   * freshly started (pre-boot) Firecracker process. Only valid in the
   * pre-boot state, i.e. against a brand-new API socket.
   * @param {object} opts
   * @param {string} opts.snapshot_path
   * @param {{backend_type: 'File'|'Uffd', backend_path: string}} opts.mem_backend
   * @param {boolean} [opts.enable_diff_snapshots] - deprecated by Firecracker
   *   but still accepted; prefer `mem_backend`
   * @param {boolean} [opts.resume_vm] - resume immediately after load
   * @returns {Promise<void>}
   */
  async loadSnapshot({ snapshot_path, mem_backend, enable_diff_snapshots, resume_vm } = {}) {
    const body = { snapshot_path }
    if (mem_backend !== undefined) body.mem_backend = mem_backend
    if (enable_diff_snapshots !== undefined) body.enable_diff_snapshots = enable_diff_snapshots
    if (resume_vm !== undefined) body.resume_vm = resume_vm
    await this.#request('PUT', '/snapshot/load', body)
  }

  // ── Introspection ────────────────────────────────────────────

  /** GET / — instance info (id, state, vmm_version, app_name). @returns {Promise<object>} */
  async getInstanceInfo() {
    const { body } = await this.#request('GET', '/')
    return body
  }

  /**
   * PATCH /balloon — resize the memory balloon device.
   * @param {object} opts
   * @param {number} opts.amount_mib
   * @returns {Promise<void>}
   */
  async patchBalloon({ amount_mib } = {}) {
    await this.#request('PATCH', '/balloon', { amount_mib })
  }

  /** GET /balloon @returns {Promise<object>} */
  async getBalloon() {
    const { body } = await this.#request('GET', '/balloon')
    return body
  }
}
