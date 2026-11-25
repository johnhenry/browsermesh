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

import { UsageError } from './output.mjs'

// The spike is loaded only when a `vm` command runs, and not when this module
// is: it lives outside the package (`spikes/`, not a workspace member), so a
// static import made the whole package unloadable without a repository
// checkout beside it -- every command, not just `vm`. It is also the same
// "only pay for what you use" shape `cli.mjs`'s dispatch has per command group.
const SPIKE_SRC_URL = new URL('../../../spikes/vm-pod-host/src/', import.meta.url)

/** The `vm` subcommands `meshctl vm <command> ...` recognizes. */
export const VM_COMMANDS = Object.freeze(['spawn', 'exec', 'snapshot', 'restore', 'drain', 'status'])

/**
 * @returns {Promise<{ cli: object, VmPodHost: Function }>}
 */
async function loadSpike() {
  try {
    const [cli, hostPod] = await Promise.all([
      import(new URL('cli.mjs', SPIKE_SRC_URL).href),
      import(new URL('host-pod.mjs', SPIKE_SRC_URL).href),
    ])
    return { cli, VmPodHost: hostPod.VmPodHost }
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new UsageError(
        'meshctl vm: this command drives the vm-pod-host spike, which is not part of the installed package; '
        + 'run it from a checkout of the repository (spikes/vm-pod-host)',
      )
    }
    throw err
  }
}

/**
 * @param {object} [opts]
 * @param {Function} [opts.onLog]
 * @param {Function} opts.VmPodHost
 */
async function startVmPodHost({ onLog, VmPodHost } = {}) {
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

  const { cli, VmPodHost } = await loadSpike()
  const host = await startVmPodHost({ onLog, VmPodHost })
  const spawnOpts = cli.demoSpawnOpts({ kernel, rootfs, dryRun })

  switch (command) {
    case 'spawn': {
      const vmPod = await cli.runSpawn(host, name, spawnOpts)
      return summarizePod(host, name, vmPod)
    }
    case 'exec': {
      const { vmPod, result } = await cli.runExec(host, name, spawnOpts, argv)
      return { ...summarizePod(host, name, vmPod), exec: result }
    }
    case 'snapshot': {
      const vmPod = await cli.runSnapshot(host, name, spawnOpts)
      return summarizePod(host, name, vmPod)
    }
    case 'restore': {
      const vmPod = await cli.runRestore(host, name, spawnOpts)
      return summarizePod(host, name, vmPod)
    }
    case 'drain': {
      const vmPod = await cli.runDrain(host, name, spawnOpts)
      return summarizePod(host, name, vmPod)
    }
    case 'status':
    default:
      return { hostPodId: host.podId, pods: cli.runStatus(host) }
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
