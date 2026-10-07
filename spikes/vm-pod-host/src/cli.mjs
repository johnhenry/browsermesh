#!/usr/bin/env node
/**
 * cli.mjs — operator CLI for the vm-pod-host spike.
 *
 * Subcommands: spawn | exec | snapshot | restore | drain | status
 *
 * Every subcommand accepts `--dry-run`, which is the only mode this CLI
 * can actually exercise on macOS or in CI (no `/dev/kvm`, no real
 * `firecracker`/`jailer` binaries, no real Firecracker API socket). In
 * `--dry-run` the VmPod records every Firecracker API call and host
 * command it *would* have made, in order, and this CLI prints them —
 * see README.md for the real-host runbook.
 *
 * Usage:
 *   node src/cli.mjs spawn <name> [--dry-run] [--kernel <path>] [--rootfs <path>]
 *   node src/cli.mjs exec <name> -- <command...> [--dry-run]
 *   node src/cli.mjs snapshot <name> [--dry-run]
 *   node src/cli.mjs restore <name> [--dry-run]
 *   node src/cli.mjs drain <name> [--dry-run]
 *   node src/cli.mjs status [--dry-run]
 *
 * State across invocations: a real deployment would run this against a
 * long-lived `VmPodHost` process (e.g. over a local RPC socket). This
 * spike's CLI is single-shot: `spawn` boots a VmPod, runs it through
 * enough of the demo lifecycle to be interesting, and prints what
 * happened — it does not persist a host process between commands.
 */

import { VmPodHost } from './host-pod.mjs'
import { fileURLToPath } from 'node:url'

/**
 * @param {string[]} argv - argv-style arguments (no node/script path)
 * @returns {{command: string, name?: string, rest: string[], dryRun: boolean, kernel: string, rootfs: string}}
 */
export function parseArgs(argv) {
  const [command, ...rest0] = argv
  let dryRun = false
  let kernel = '/boot/vmlinux'
  let rootfs = '/var/lib/vm-pod-host/demo/rootfs.ext4'
  const rest = []
  for (let i = 0; i < rest0.length; i++) {
    const arg = rest0[i]
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--kernel') { kernel = rest0[++i]; continue }
    if (arg === '--rootfs') { rootfs = rest0[++i]; continue }
    rest.push(arg)
  }
  const name = rest[0]
  const commandArgs = rest.slice(1).filter((a) => a !== '--')
  return { command, name, rest: commandArgs, dryRun, kernel, rootfs }
}

function demoSpawnOpts({ kernel, rootfs, dryRun }) {
  return {
    kernelImage: kernel,
    rootfs,
    tap: { hostDevName: 'tap-demo', guestMac: 'AA:BB:CC:DD:EE:01' },
    vsock: { guestCid: 3, udsPath: '/var/lib/vm-pod-host/demo/v.sock' },
    limits: { vcpus: 1, memMib: 128 },
    snapshotDir: '/var/lib/vm-pod-host/demo/snapshots',
    idleTimeoutMs: 30_000,
    dryRun,
  }
}

function printPlan(vmPod, log) {
  log(`\nstate: ${vmPod.state}`)
  log('\nplanned host commands:')
  for (const c of vmPod.plannedCommands) {
    log(`  $ ${c.argv.join(' ')}${c.description ? `   # ${c.description}` : ''}`)
  }
  log('\nplanned Firecracker API calls:')
  for (const c of vmPod.plannedApiCalls) {
    log(`  ${c.api}(${c.args !== undefined ? JSON.stringify(c.args) : ''})`)
  }
  log('')
}

/**
 * @param {string[]} argv - process.argv.slice(2)
 * @param {{log?: Function}} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const log = io.log ?? console.log
  const { command, name, rest, dryRun, kernel, rootfs } = parseArgs(argv)

  if (!command) {
    log('usage: cli.mjs <spawn|exec|snapshot|restore|drain|status> [name] [--dry-run]')
    return 1
  }

  if (!dryRun) {
    log('[vm-pod-host] refusing to run outside --dry-run: this environment has no Firecracker/jailer binaries or /dev/kvm.')
    log('[vm-pod-host] see README.md for the real-host runbook; pass --dry-run to see the planned calls instead.')
    return 1
  }

  const host = new VmPodHost({ dryRun: true, onLog: log })
  await host.start()
  log(`[vm-pod-host] host pod: ${host.podId}`)

  switch (command) {
    case 'spawn': {
      if (!name) { log('spawn requires a name'); return 1 }
      const vmPod = await host.spawn(name, demoSpawnOpts({ kernel, rootfs, dryRun }))
      vmPod.markRegistered(`guest-${name}`)
      log(`[vm-pod-host] "${name}" cold-booted (dry-run) and marked registered as guest-${name}`)
      printPlan(vmPod, log)
      return 0
    }
    case 'exec': {
      if (!name) { log('exec requires a name'); return 1 }
      const vmPod = await host.spawn(name, demoSpawnOpts({ kernel, rootfs, dryRun }))
      vmPod.markRegistered(`guest-${name}`)
      const result = await host.exec(name, rest.length ? rest : ['echo', 'hello'])
      log(`[vm-pod-host] exec result: ${JSON.stringify(result)}`)
      printPlan(vmPod, log)
      return 0
    }
    case 'snapshot': {
      if (!name) { log('snapshot requires a name'); return 1 }
      const vmPod = await host.spawn(name, demoSpawnOpts({ kernel, rootfs, dryRun }))
      vmPod.markRegistered(`guest-${name}`)
      await host.snapshot(name)
      printPlan(vmPod, log)
      return 0
    }
    case 'restore': {
      if (!name) { log('restore requires a name'); return 1 }
      const vmPod = await host.spawn(name, demoSpawnOpts({ kernel, rootfs, dryRun }))
      vmPod.markRegistered(`guest-${name}`)
      await host.snapshot(name)
      await host.restore(name)
      printPlan(vmPod, log)
      return 0
    }
    case 'drain': {
      if (!name) { log('drain requires a name'); return 1 }
      const vmPod = await host.spawn(name, demoSpawnOpts({ kernel, rootfs, dryRun }))
      vmPod.markRegistered(`guest-${name}`)
      await host.drain(name)
      log(`[vm-pod-host] "${name}" drained, state: cold`)
      return 0
    }
    case 'status': {
      log(JSON.stringify(host.status(), null, 2))
      return 0
    }
    default:
      log(`unknown command: ${command}`)
      return 1
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const code = await main(process.argv.slice(2))
  process.exitCode = code
}
