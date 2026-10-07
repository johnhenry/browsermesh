/**
 * vm-bridge.mjs — `meshctl vm ...`, folding the WP3 spike CLI
 * (`spikes/vm-pod-host/src/cli.mjs`) under `meshctl` by IMPORTING its
 * functions, not reimplementing them.
 *
 * `vm` is the odd command group out, and the design doc is explicit about
 * why: `vm` talks to a LOCAL `VmPodHost` directly (an in-process
 * Firecracker driver, `--dry-run` only outside a real microVM host), while
 * `pods` always goes over the mesh via `pod-host:request` envelopes. `vm`
 * needs no `--loopback`/`--signaling`, no identity, no `PeerNode` at all --
 * `cli.mjs`'s `main()` dispatch skips connecting to anything for this
 * group entirely.
 *
 * `spikes/vm-pod-host/src/cli.mjs` is a sibling SPIKE, not a workspace
 * package (root `workspaces` stays `packages/*` — see that spike's own
 * `package.json`), so this is a plain relative import across the
 * monorepo rather than a dependency in `package.json`. That is the
 * deliberate shape of "fold the WP3 CLI under meshctl vm ... by importing
 * its functions" — not a new package, not copied code.
 */

import {
  demoSpawnOpts, runSpawn, runExec, runSnapshot, runRestore, runDrain, runStatus,
} from '../../../spikes/vm-pod-host/src/cli.mjs'
import { UsageError } from './output.mjs'

// `VmPodHost` is imported dynamically (see `startVmPodHost()` below) so
// that a `meshctl` run that never touches `vm` never pays for loading the
// Firecracker driver stack at all -- the same "only pay for what you use"
// shape `cli.mjs`'s own dispatch already has at the command-group level.
const HOST_POD_MODULE_URL = new URL('../../../spikes/vm-pod-host/src/host-pod.mjs', import.meta.url)

/** The `vm` subcommands `meshctl vm <command> ...` recognizes. */
export const VM_COMMANDS = Object.freeze(['spawn', 'exec', 'snapshot', 'restore', 'drain', 'status'])

/**
 * @param {object} [opts]
 * @param {Function} [opts.onLog]
 * @returns {Promise<InstanceType<typeof import('../../../spikes/vm-pod-host/src/host-pod.mjs').VmPodHost>>}
 */
async function startVmPodHost({ onLog } = {}) {
  const { VmPodHost } = await import(HOST_POD_MODULE_URL)
  const host = new VmPodHost({ dryRun: true, onLog: onLog || (() => {}) })
  await host.start()
  return host
}

/**
 * Run one `meshctl vm <command>` invocation.
 *
 * Every command besides `status` needs `--dry-run`: there is no Firecracker
 * host behind `meshctl` any more than there was behind the spike CLI it
 * wraps (no `/dev/kvm`, no real `firecracker`/`jailer` binaries) -- see
 * `spikes/vm-pod-host/README.md` for the real-host runbook this defers to.
 *
 * @param {object} opts
 * @param {string} opts.command - One of `VM_COMMANDS`.
 * @param {string} [opts.name] - Required for every command but `status`.
 * @param {string[]} [opts.argv] - `exec`'s command, after `--`.
 * @param {boolean} [opts.dryRun]
 * @param {string} [opts.kernel]
 * @param {string} [opts.rootfs]
 * @param {Function} [opts.onLog]
 * @returns {Promise<object>} JSON-serializable result.
 */
export async function runVmCommand({
  command, name, argv = [], dryRun = false, kernel = '/boot/vmlinux',
  rootfs = '/var/lib/vm-pod-host/demo/rootfs.ext4', onLog,
} = {}) {
  if (!VM_COMMANDS.includes(command)) {
    throw new UsageError(`meshctl vm: unknown command '${command}' (expected one of ${VM_COMMANDS.join('|')})`)
  }
  if (command !== 'status' && !dryRun) {
    throw new UsageError(
      "meshctl vm: pass --dry-run -- this host has no Firecracker/jailer binaries or /dev/kvm "
      + '(same restriction as spikes/vm-pod-host/src/cli.mjs)',
    )
  }
  if (command !== 'status' && !name) {
    throw new UsageError(`meshctl vm ${command}: a pod name is required`)
  }

  const host = await startVmPodHost({ onLog })
  const spawnOpts = demoSpawnOpts({ kernel, rootfs, dryRun })

  switch (command) {
    case 'spawn': {
      const vmPod = await runSpawn(host, name, spawnOpts)
      return summarizePod(host, name, vmPod)
    }
    case 'exec': {
      const { vmPod, result } = await runExec(host, name, spawnOpts, argv)
      return { ...summarizePod(host, name, vmPod), exec: result }
    }
    case 'snapshot': {
      const vmPod = await runSnapshot(host, name, spawnOpts)
      return summarizePod(host, name, vmPod)
    }
    case 'restore': {
      const vmPod = await runRestore(host, name, spawnOpts)
      return summarizePod(host, name, vmPod)
    }
    case 'drain': {
      const vmPod = await runDrain(host, name, spawnOpts)
      return summarizePod(host, name, vmPod)
    }
    case 'status':
    default:
      return { hostPodId: host.podId, pods: runStatus(host) }
  }
}

/**
 * @param {object} host
 * @param {string} name
 * @param {object} vmPod
 * @returns {object}
 */
function summarizePod(host, name, vmPod) {
  return {
    hostPodId: host.podId,
    name,
    state: vmPod.state,
    plannedCommands: vmPod.plannedCommands,
    plannedApiCalls: vmPod.plannedApiCalls,
  }
}
