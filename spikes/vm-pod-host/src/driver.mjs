/**
 * driver.mjs — `PodHostDriver` adapter for WP3's `VmPodHost` (issue #185's
 * hosted-pods control surface, item 2).
 *
 * `VmPodHost` (host-pod.mjs) already does everything a microVM lane needs:
 * `spawn`/`exec`/`snapshot`/`restore`/`drain`/`status`. What it does NOT
 * speak is the lane-agnostic protocol in
 * `@johnhenry/browsermesh-pod`'s `host-protocol.mjs` — its `spawn()` takes
 * Firecracker-shaped options (kernel image, rootfs, TAP device, vsock CID),
 * not a podspec, and its failures are plain `Error`s rather than coded
 * `PodHostDriverError`s. This file is that translation layer, and nothing
 * else: no new lifecycle, no second state machine.
 *
 * Two mappings worth stating explicitly:
 *
 *   - **States are identity-mapped.** `VmPod`'s own state names (`cold`,
 *     `booting`, `registered`, `serving`, `paused`, `snapshotted`,
 *     `restoring`, `draining`) were taken from the same §5.3 diagram
 *     `POD_LIFECYCLE` was, so no translation table is needed. The one
 *     protocol state `VmPod` has no equivalent for is the terminal `gone`,
 *     which this driver synthesizes: `VmPodHost.drain()` forgets the VM
 *     entirely, so without a tombstone here a drained pod would answer
 *     `ENOENT` instead of `gone`.
 *   - **`send` is `ENOTSUP`, not `ELANE`.** The microvm lane could
 *     perfectly well deliver a message to a guest (over vsock, the same way
 *     `exec` does); WP3's host agent simply has no such method yet. That is
 *     a driver gap, which is exactly what `ENOTSUP` means.
 *
 * Firecracker-specific spawn options that a podspec has no field for
 * (kernel image, snapshot directory, jailer settings) come from this
 * driver's own construction options, not from the requester — a remote
 * peer must not get to name a path on the host's filesystem. The only
 * podspec fields that reach Firecracker are `limits` (which map 1:1 onto
 * `VmPodLimits`) and, for a `run.kind: 'rootfs'` spec, a rootfs *alias*
 * resolved through `rootfsCatalog`.
 */

import {
  POD_HOST_ERROR,
  POD_HOST_EVENT_KIND,
  POD_HOST_VERB,
  POD_LANE,
  POD_LIFECYCLE,
  PodHostDriverError,
  createHostEvent,
  createUnsupportedDriverMethod,
  validatePodSpec,
} from '../../../packages/browsermesh-pod/src/index.mjs'

/** Verbs this driver serves. `send` is absent on purpose — see the module doc comment. */
const VERBS = Object.freeze([
  POD_HOST_VERB.SPAWN, POD_HOST_VERB.STATUS, POD_HOST_VERB.EXEC,
  POD_HOST_VERB.SNAPSHOT, POD_HOST_VERB.RESTORE, POD_HOST_VERB.DRAIN,
  POD_HOST_VERB.LIST,
])

/**
 * Translate a `VmPodHost`/`VmPod` error into a coded `PodHostDriverError`.
 *
 * @param {*} err
 * @param {string} name
 * @returns {PodHostDriverError}
 */
function translateError(err, name) {
  if (err instanceof PodHostDriverError) return err
  const message = err?.message || String(err)
  if (/no VM named/.test(message)) {
    return new PodHostDriverError(POD_HOST_ERROR.ENOENT, message, { name })
  }
  if (/already spawned/.test(message)) {
    return new PodHostDriverError(POD_HOST_ERROR.EEXIST, message, { name })
  }
  // `VmPodStateError` ("invalid transition X -> Y") and "is not reachable
  // (state: X)" are both the same class of failure: the pod is alive but
  // in the wrong state for this verb right now.
  if (/not reachable|invalid transition/.test(message)) {
    return new PodHostDriverError(POD_HOST_ERROR.EBUSY, message, { name })
  }
  return new PodHostDriverError(POD_HOST_ERROR.EINVAL, message, { name })
}

/**
 * Build a `PodHostDriver` over a WP3 `VmPodHost`.
 *
 * @param {object} vmPodHost - A `VmPodHost` (host-pod.mjs).
 * @param {object} [opts]
 * @param {string} [opts.kernelImage='/boot/vmlinux'] - Host path to the guest kernel.
 * @param {string} [opts.rootfs='/vm/rootfs.ext4'] - Default rootfs image.
 * @param {Record<string, string>} [opts.rootfsCatalog] - Maps a podspec's
 *   `run.ref` (for `run.kind: 'rootfs'`) to a host path. A ref with no
 *   catalog entry is rejected `EINVAL`: a remote requester never names a
 *   host path directly.
 * @param {string} [opts.snapshotDir='/vm/snapshots']
 * @param {string} [opts.runDir='/vm/run'] - Where per-pod vsock sockets live.
 * @param {number} [opts.firstGuestCid=3] - vsock CIDs are allocated from here.
 * @param {number} [opts.idleTimeoutMs]
 * @param {boolean} [opts.dryRun]
 * @param {(name: string, spec: object) => object} [opts.spawnOptions] - Last
 *   word on the options handed to `VmPodHost.spawn()`; merged over
 *   everything this driver computed.
 * @returns {import('../../../packages/browsermesh-pod/src/index.mjs').PodHostDriver}
 */
export function createVmPodDriver(vmPodHost, opts = {}) {
  if (!vmPodHost || typeof vmPodHost.spawn !== 'function') {
    throw new Error('createVmPodDriver: a VmPodHost is required')
  }

  const {
    kernelImage = '/boot/vmlinux',
    rootfs: defaultRootfs = '/vm/rootfs.ext4',
    rootfsCatalog = null,
    snapshotDir = '/vm/snapshots',
    runDir = '/vm/run',
    firstGuestCid = 3,
    idleTimeoutMs,
    dryRun,
    spawnOptions,
  } = opts

  /** @type {Map<string, {spec: object, createdAt: number, updatedAt: number, gone: boolean}>} */
  const records = new Map()
  /** @type {Set<(event: object) => void>} */
  const listeners = new Set()
  let nextGuestCid = firstGuestCid

  /** @param {object} event */
  function emit(event) {
    for (const fn of [...listeners]) {
      try {
        fn(event)
      } catch {
        // A throwing subscriber never breaks the driver.
      }
    }
  }

  /**
   * @param {string} name
   * @param {string} state
   * @returns {object}
   */
  function statusOf(name, state) {
    const record = records.get(name)
    const vmPod = vmPodHost.vms.get(name)
    return {
      name,
      lane: POD_LANE.MICROVM,
      state,
      spec: record?.spec,
      createdAt: record?.createdAt ?? 0,
      updatedAt: Date.now(),
      podId: vmPod?.podId ?? null,
    }
  }

  /**
   * `VmPod` state names are already `POD_LIFECYCLE` values; the only
   * synthesis is the tombstone a drained (and therefore forgotten) VM
   * leaves behind.
   * @param {string} name
   * @returns {string}
   */
  function liveState(name) {
    const vmPod = vmPodHost.vms.get(name)
    if (vmPod) return vmPod.state
    const record = records.get(name)
    if (record?.gone) return POD_LIFECYCLE.GONE
    throw new PodHostDriverError(POD_HOST_ERROR.ENOENT, `no VM named "${name}"`, { name })
  }

  return {
    lane: POD_LANE.MICROVM,

    capabilities() {
      return { verbs: [...VERBS] }
    },

    onEvent(fn) {
      if (typeof fn !== 'function') return () => {}
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },

    async spawn(spec) {
      const validated = validatePodSpec(spec)
      if (!validated.ok) {
        throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, validated.errors.join('; '), {
          errors: validated.errors,
        })
      }
      const value = validated.value
      if (value.lane !== POD_LANE.MICROVM) {
        throw new PodHostDriverError(
          POD_HOST_ERROR.ELANE,
          `this host runs the '${POD_LANE.MICROVM}' lane, not '${value.lane}'`,
          { lane: value.lane },
        )
      }

      let rootfs = defaultRootfs
      if (value.run.kind === 'rootfs') {
        rootfs = rootfsCatalog ? rootfsCatalog[value.run.ref] : undefined
        if (!rootfs) {
          throw new PodHostDriverError(
            POD_HOST_ERROR.ENOENT,
            `no rootfs registered under '${value.run.ref}'`,
            { ref: value.run.ref },
          )
        }
      }

      const name = value.name
      const guestCid = nextGuestCid
      nextGuestCid += 1

      const spawnOpts = {
        kernelImage,
        rootfs,
        tap: { hostDevName: `tap-${name}` },
        vsock: { guestCid, udsPath: `${runDir}/${name}.vsock` },
        limits: value.limits ?? {},
        snapshotDir,
        ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
        ...(dryRun === undefined ? {} : { dryRun }),
        ...(typeof spawnOptions === 'function' ? spawnOptions(name, value) : {}),
      }

      let vmPod
      try {
        vmPod = await vmPodHost.spawn(name, spawnOpts)
      } catch (err) {
        throw translateError(err, name)
      }

      records.set(name, { spec: value, createdAt: Date.now(), updatedAt: Date.now(), gone: false })
      // `VmPod` is an EventEmitter that already announces every transition;
      // republish them as protocol events rather than polling state.
      vmPod.on('transition', ({ from, to, reason }) => {
        emit(createHostEvent(POD_HOST_EVENT_KIND.LIFECYCLE, {
          name, lane: POD_LANE.MICROVM, from, to, reason,
        }))
      })
      return statusOf(name, vmPod.state)
    },

    async status(name) {
      return statusOf(name, liveState(name))
    },

    // The microvm lane could deliver a message over vsock; WP3's host agent
    // has no such method yet, so this is a driver gap (`ENOTSUP`), not a
    // lane limit (`ELANE`).
    send: createUnsupportedDriverMethod(POD_HOST_VERB.SEND, POD_LANE.MICROVM),

    async exec(name, argv) {
      liveState(name)
      try {
        return await vmPodHost.exec(name, argv)
      } catch (err) {
        throw translateError(err, name)
      }
    },

    async snapshot(name) {
      liveState(name)
      try {
        await vmPodHost.snapshot(name)
      } catch (err) {
        throw translateError(err, name)
      }
      return statusOf(name, liveState(name))
    },

    async restore(name) {
      liveState(name)
      try {
        await vmPodHost.restore(name)
      } catch (err) {
        throw translateError(err, name)
      }
      return statusOf(name, liveState(name))
    },

    async drain(name, drainOpts = {}) {
      liveState(name)
      try {
        await vmPodHost.drain(name)
      } catch (err) {
        throw translateError(err, name)
      }
      const record = records.get(name)
      if (record) record.gone = true
      emit(createHostEvent(POD_HOST_EVENT_KIND.EXIT, {
        name, lane: POD_LANE.MICROVM, code: 0, cascade: drainOpts.cascade === true,
      }))
      return statusOf(name, POD_LIFECYCLE.GONE)
    },

    async list() {
      const live = vmPodHost.status()
      const out = []
      for (const [name, info] of Object.entries(live)) out.push(statusOf(name, info.state))
      for (const [name, record] of records) {
        if (record.gone && !(name in live)) out.push(statusOf(name, POD_LIFECYCLE.GONE))
      }
      return out
    },
  }
}
