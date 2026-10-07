# vm-pod-host — Firecracker microVM pod host spike

This is Work Package 3 ("microVM pod host spike") from
[browsermesh#185](https://github.com/johnhenry/browsermesh/issues/185),
sections 5 and 8/WP3. It implements Lane B ("microVM pod") of the
hosted-pods design: a host-side agent that drives Firecracker microVMs
through their REST API, a lifecycle state machine matching issue §5.3,
and the guest-side pieces needed to run `browsermesh-servers/kernel`'s
`ServerPod` inside one.

It is a **spike**, not a package: it lives under `spikes/`, is not a
member of this repo's `packages/*` npm workspaces, is not published, and
has zero runtime dependencies (pure Node: `node:http`, `node:net`,
`node:events`, `node:child_process`).

## What was actually run, honestly

**Built and tested on macOS against a fake API. Since the rebase onto
`main`, the Firecracker API client has also been run against a real
Firecracker v1.16.1 on a KVM host (see "Measurements"); the full `VmPod`
lifecycle, the jailer path and the guest image have still not run for
real.**

This spike was written on macOS, which has neither `/dev/kvm` nor a
`firecracker`/`jailer` binary. Concretely, here is exactly what ran and
what didn't:

| Component | Ran? | How |
| --- | --- | --- |
| `src/firecracker-client.mjs` | **Yes** | Every method tested against `test/fake-firecracker-server.mjs`, a `node:http` server on a real unix socket that shapes responses like the real Firecracker API (204 on success, 400 + `fault_message` on failure) |
| `src/jailer.mjs` | **Yes** | Pure functions, unit tested directly — no process is ever spawned by this module |
| `src/vsock-bridge.mjs` | **Yes** | Tested against a fake AF_UNIX server implementing the `CONNECT`/`OK` handshake, and a real `net.Server` for the guest-initiated-connection path |
| `src/vm-pod.mjs` | **Yes, in `dryRun` only** | Full lifecycle (cold boot → registered → serving → paused → snapshotted → restoring → registered → draining → cold) tested with the exact sequence of planned API calls and host commands asserted |
| `src/host-pod.mjs` | **Yes, in `dryRun` only** | `spawn`/`exec`/`snapshot`/`restore`/`drain` tested as a `Pod` subclass boot, matching `ServerPod`'s own boot pattern |
| `src/cli.mjs` | **Yes, `--dry-run` only** | `node src/cli.mjs spawn demo --dry-run` runs end-to-end and prints the full planned command/call sequence (see below) |
| `guest/init`, `guest/vsock-exec-responder.mjs` | **No** | Written and reviewed against the Firecracker docs; never executed (no guest kernel, no guest userland to run them in) |
| `guest/build-rootfs.sh` | **No** | Written and reviewed; never executed (needs root, loop-mount, `mkfs.ext4`, none of which this spike attempted on macOS) |
| Real `firecracker`/`jailer` binaries | **No** | Never installed or invoked. Every "host command" (`ip`, `nft`, `jailer`, `pkill`) that `vm-pod.mjs` would run is either skipped (`dryRun: true`) or routed through an injectable `exec(argv)` the caller controls — nothing in this spike shells out directly |

Two independent execution modes exist in `vm-pod.mjs`/`host-pod.mjs`,
always available on every instance:

- **`dryRun: true`** — nothing is actually called. Every planned
  Firecracker API call is recorded into `vmPod.plannedApiCalls` and
  every planned host command into `vmPod.plannedCommands`, in the exact
  order they would run. This is what the CLI and the lifecycle tests
  use, because it's the only thing that works on a machine without KVM.
- **`dryRun: false`** — API calls go through a real
  `FirecrackerClient` (the fake server in tests, or a real Firecracker
  socket on Linux) and host commands go through a real injected `exec`.

## Layout

```
spikes/vm-pod-host/
  src/
    firecracker-client.mjs   FirecrackerClient over http.request({socketPath})
    jailer.mjs                pure argv builder + chroot socket path
    vm-pod.mjs                lifecycle state machine (issue §5.3)
    vsock-bridge.mjs          host<->guest vsock UDS protocol
    host-pod.mjs               VmPodHost extends Pod, manages a Map<name, VmPod>
    cli.mjs                    spawn|exec|snapshot|restore|drain|status, --dry-run
  guest/
    init                       PID 1 for the guest rootfs (not executed, see above)
    vsock-exec-responder.mjs   tiny exec responder bridged over vsock (not executed)
    build-rootfs.sh            Alpine + Node + kernel rootfs builder (not executed)
    README.md                  where to get vmlinux, rootfs build instructions
  test/
    fake-firecracker-server.mjs
    firecracker-client.test.mjs
    jailer.test.mjs
    vsock-bridge.test.mjs
    vm-pod.test.mjs
    host-pod.test.mjs
    cli.test.mjs
```

## Running the tests

```sh
node --test spikes/vm-pod-host/test/*.test.mjs
```

72 tests, all passing on macOS (Node v26), in well under a second —
no network, no KVM, no sudo.

## Try it: `cli.mjs --dry-run`

```sh
node spikes/vm-pod-host/src/cli.mjs spawn demo --dry-run
```

prints the host pod's identity, then the exact planned sequence for a
cold boot:

```
planned host commands:
  $ jailer --id demo --exec-file /usr/bin/firecracker --uid 0 --gid 0 --chroot-base-dir /srv/jailer -- --api-sock /run/firecracker.socket   # spawn jailer (fronting firecracker)
  $ ip tuntap add tap-demo mode tap   # create TAP device
  $ ip link set tap-demo up   # bring TAP device up
  $ nft add rule firecracker filter iifname tap-demo oifname eth0 accept   # nftables: allow TAP -> uplink forwarding (masquerade)

planned Firecracker API calls:
  putMachineConfig({"vcpu_count":1,"mem_size_mib":128,"track_dirty_pages":true})
  putBootSource({"kernel_image_path":"/boot/vmlinux","boot_args":"console=ttyS0 reboot=k panic=1 root=/dev/vda rw"})
  putDrive(["rootfs",{"path_on_host":"/var/lib/vm-pod-host/demo/rootfs.ext4","is_root_device":true,"is_read_only":false}])
  putNetworkInterface(["eth0",{"host_dev_name":"tap-demo","guest_mac":"AA:BB:CC:DD:EE:01"}])
  putVsock({"guest_cid":3,"uds_path":"/var/lib/vm-pod-host/demo/v.sock"})
  start()
```

Other subcommands: `exec <name> -- <cmd...>`, `snapshot <name>`,
`restore <name>`, `drain <name>`, `status`, all `--dry-run`-only outside
a real Linux+KVM host (the CLI refuses to run without `--dry-run`
anywhere, since there is nothing real to call).

## Runbook: running this for real on a Linux + KVM host

None of the following has been executed by this spike. It is the
intended path to turn "planned calls" into real ones.

1. **Install Firecracker + jailer.**
   ```sh
   ARCH=$(uname -m)
   curl -fsSL -o firecracker.tgz \
     "https://github.com/firecracker-microvm/firecracker/releases/latest/download/firecracker-vX.Y.Z-${ARCH}.tgz"
   tar xzf firecracker.tgz
   sudo install -m 755 release-*/firecracker-*-${ARCH} /usr/bin/firecracker
   sudo install -m 755 release-*/jailer-*-${ARCH} /usr/bin/jailer
   ```
   (check the Firecracker releases page for the current version/asset
   naming — this spike did not pin one).

2. **Fetch a `vmlinux`.** See `guest/README.md` — either a Firecracker
   CI artifact or your own build from
   `resources/guest_configs/` in the Firecracker repo.

3. **Build the rootfs.**
   ```sh
   git clone git@github.com:johnhenry/browsermesh-servers.git /tmp/browsermesh-servers
   KERNEL_SRC_DIR=/tmp/browsermesh-servers/kernel \
     sudo spikes/vm-pod-host/guest/build-rootfs.sh ./rootfs.ext4
   ```

4. **Create a TAP device + NAT** (see `docs/network-setup.md` on the
   Firecracker `main` branch for the authoritative version):
   ```sh
   sudo ip tuntap add tap-demo mode tap
   sudo ip addr add 172.16.0.1/30 dev tap-demo
   sudo ip link set tap-demo up
   echo 1 | sudo tee /proc/sys/net/ipv4/ip_forward
   sudo nft add table firecracker
   sudo nft 'add chain firecracker postrouting { type nat hook postrouting priority srcnat; policy accept; }'
   sudo nft add rule firecracker postrouting ip saddr 172.16.0.2 oifname eth0 counter masquerade
   ```

5. **Run it.**
   ```sh
   node spikes/vm-pod-host/src/cli.mjs spawn demo \
     --kernel /path/to/vmlinux --rootfs ./rootfs.ext4
   # (omit --dry-run; requires root for jailer, a real /usr/bin/firecracker,
   #  and the TAP device created above — wire a real `exec` and
   #  `FirecrackerClient` into VmPodHost for this to actually work;
   #  the shipped cli.mjs intentionally refuses non-dry-run runs
   #  because this spike never validated that path)
   ```

## Measurements

Issue #185 §9 asks WP3 for three numbers. The full guest (Alpine + Node +
`ServerPod`) has still not been built or booted, so **no number below is a
"boot → `registered`" figure**. What has run is one real Firecracker v1.16.1
(`nix shell nixpkgs#firecracker`) on an x86_64 NixOS box with `/dev/kvm`,
unprivileged and without the jailer, driven by this spike's own
`FirecrackerClient` (`putMachineConfig` with `track_dirty_pages`,
`putBootSource` with an `initrd_path`, `putVsock`, `start`, `pause`,
`createSnapshot`, then a second Firecracker process and `loadSnapshot`),
with Firecracker CI's `vmlinux-6.1.188` and a ~800 KB busybox initramfs
whose `/init` prints a tick every second. 128 MiB, 1 vCPU, no network.

| Measurement | Target (issue §9) | Measured (kernel + busybox initramfs, not the real guest) |
| --- | --- | --- |
| `start()` → guest `/init` printed | < 1 s (to `registered`) | ~585 ms wall (guest reports 0.35 s uptime) |
| `pause()` | | 3 ms |
| `createSnapshot` (Full, 128 MiB) | | ~460 ms |
| `loadSnapshot` + resume (API call) | < 300 ms | 8 ms; the guest was ticking again on its next tick |
| Firecracker RSS after restore (idle, file-backed memory) | < 40 MB | ~19 MB |

The real-guest boot-to-`registered` figure (Node start, `ServerPod`
registering over the signaling server) is still open, as is everything that
needs root: jailer, TAP/nft setup, and `build-rootfs.sh`.

Two things this run exposed that the fake-API tests could not:

1. **The vsock UDS survives a killed VMM, and Firecracker refuses to bind
   over it.** `loadSnapshot` on a second process failed with
   `VsockUnixBackend: Error binding to the host-side Unix socket: Address
   already in use` until the old `uds_path` was unlinked. `VmPod.restore()`
   does not remove it yet.
2. **`VmPod.restore()` does not start a VMM process.** Its doc comment says it
   spawns a fresh pre-boot Firecracker, but `snapshot()` kills the VMM and
   `restore()` goes straight to `loadSnapshot` on the same client, so against
   a real host there is nothing listening on the API socket. The spawn
   (jailer or plain `firecracker --api-sock`) belongs in `restore()` before
   `loadSnapshot`. Tracked as a wave 3 item.

## Design notes / deviations from the issue text

- **State names.** Issue §8/WP3 lists the lifecycle as `cold → booting →
  registered → serving → idle/paused → snapshotted → restoring →
  registered → draining`. The §5.3 Mermaid diagram (the normative
  version) has no separate `idle` state — only `Paused`, reached via an
  idle *timeout* from `Registered`. This implementation follows the
  diagram: states are `cold, booting, registered, serving, paused,
  snapshotted, restoring, draining`, and "idle" is the *trigger*
  (`idleTimeoutMs` with no `serving` activity), not a state of its own.
  Flagging this so the issue text can be reconciled with the diagram —
  right now they say two slightly different things.
- **vsock from a zero-dependency Node guest.** The issue's vsock.md
  reference doesn't mention this, but it matters for implementation:
  Node has no built-in `AF_VSOCK` support in `node:net`, and this
  project is zero-dependency, so the guest side can't open a vsock
  listener directly from Node. `guest/init` bridges
  `VSOCK-LISTEN:52` to a local UNIX socket with `socat` (present in the
  Alpine base image) and only the UNIX-socket side is Node
  (`guest/vsock-exec-responder.mjs`). Worth calling out in the issue if
  WP3's "tiny vsock exec responder" is expected to be pure Node with no
  such bridge — as written it isn't possible without either a native
  addon (conflicts with the zero-deps goal) or this bridge.
- **Firecracker API success responses are empty.** The issue's §5.2
  sequence diagram shows `PUT /boot-source` etc. without detail on
  response bodies; worth noting for implementers: real Firecracker
  returns `204 No Content` (no body) for every successful PUT/PATCH,
  and `200` + JSON only for GETs. `firecracker-client.mjs` and the fake
  server both model this; a client that expects a JSON body back from
  `putBootSource()` etc. would break against the real API.
- **`snapshot/create` requires `Paused` and, for a *restorable*
  snapshot, `track_dirty_pages: true` set in `machine-config` before
  boot** — not mentioned explicitly in issue §5.1's device/API bullet
  list. `vm-pod.mjs`'s `boot()` always sets `track_dirty_pages: true`
  for this reason.
- **`loadSnapshot`'s `enable_diff_snapshots` field is deprecated** in
  favor of `mem_backend` per the current swagger spec, though issue
  §8/WP3's deliverable list asks for both — this client implements
  both (`enable_diff_snapshots` is still accepted by the real API) but
  `vm-pod.mjs` only ever sends `mem_backend`.
- **No MMDS.** The guest gets its network config and `SIGNALING_URL`
  via kernel `boot_args` (parsed out of `/proc/cmdline` by `guest/init`),
  not Firecracker's MMDS metadata service. Issue #185 doesn't mention
  MMDS either way; this is simpler for a spike but would be worth
  revisiting for a real deployment (MMDS avoids baking config into the
  boot_args string, which is visible in the Firecracker API's
  `GET /boot-source` response).

## Relationship to the rest of issue #185

- `VmPodHost` (`src/host-pod.mjs`) advertises
  `{ runtimeClasses: ['microvm'], shellBackend: 'vm-console',
  deploymentSupport: { canDeploy: true } }` via a `metadata` getter —
  the exact shape `runtimePeerToComputeDescriptor()` in
  `packages/browsermesh-apps/src/orchestrator.mjs` reads off
  `peer.metadata` and `peer.shellBackend` (§6 of the issue). Wiring a
  real discovery/transport adapter so that metadata actually reaches the
  orchestrator is out of scope here — WP4 territory.
- `guest/init` execs `node /opt/browsermesh-servers/kernel/index.mjs`
  with `SIGNALING_URL` from the kernel cmdline — the identical entry
  point `browsermesh-servers/kernel/index.mjs` uses outside a microVM,
  so the guest is a completely ordinary `ServerPod` from the mesh's
  point of view once it's up.
