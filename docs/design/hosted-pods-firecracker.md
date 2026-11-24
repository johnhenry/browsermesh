# Hosted pods: the Firecracker (microVM) lane driver

Part of [#185](https://github.com/johnhenry/browsermesh/issues/185). This is
the specification of the microVM lane's host driver, written against the lane
driver interface (`PodHostDriver`, `packages/browsermesh-pod/src/host-protocol.mjs`)
and against what is built in `spikes/vm-pod-host`.

> **Status, stated plainly.** No code in this lane has booted a real microVM
> in the jailer, with the network policy, or with the guest image. The
> development machine is macOS arm64: no `/dev/kvm`, no `firecracker`, no
> `jailer`, no nftables. The only real run is the one recorded in
> `spikes/vm-pod-host/README.md` (Firecracker 1.16.1, the API client alone,
> unprivileged, no jailer, a busybox initramfs). Everything else is
> exercised against a **fake Firecracker HTTP API on a unix socket**
> (`test/fake-firecracker-server.mjs`) and recorded host commands. Where
> this document says "the driver does X" it means "the driver is built and
> tested to send/run X"; whether Firecracker, the jailer and the kernel
> accept it is what `npm run test:real-firecracker` on a Linux/KVM host
> checks, and that test has also never run. Section 11 lists what is
> verified and what is not.

## 1. Where it sits

```
orchestrator / pool            (pod-placement.mjs: lane, capacity, health, boundary)
        |  podspec, verbs
pod-host service               (pod-host-service.mjs: ACL gate, audit, events)
        |  PodHostDriver
createVmPodDriver()            (driver.mjs: podspec -> VmPodHost.spawn options)
        |
VmPodHost  (a Pod on the host)  one VmPod per microVM  (host-pod.mjs, vm-pod.mjs)
        |  host commands (ip, nft, cp, chown, jailer)      FirecrackerClient (HTTP on a unix socket)
        v                                                        v
   the host                                           firecracker, inside the jailer's chroot
                                                              |  virtio-net (TAP), virtio-block, vsock
                                                          guest: init, vsock exec responder, ServerPod
```

The orchestrator never sees Firecracker. It sees a `PodHostDriver` whose
`lane` is `microvm`, which serves `spawn`, `status`, `exec`, `snapshot`,
`restore`, `drain`, `list` (`send` is `ENOTSUP`: the guest has no vsock
message path yet, only `exec`).

## 2. What the orchestrator must know about a microVM host

Advertised by `describe()` (`pod-host-service.mjs`) and read by
`pod-placement.mjs`:

| Field | Value for this lane |
| --- | --- |
| `lane` / `runtimeClasses` | `microvm` |
| boundary | `hardware` (KVM) — see section 9 for what that does and does not mean |
| verbs | spawn, status, exec, snapshot, restore, drain, list |
| `shellBackend` | `vm-console` (so `exec` and `compute` placement see it) |
| capacity | pods per host, vcpus and MiB the operator allows (not read from the machine) |
| health | per-host circuit breaker, fed by `ETIMEDOUT` from this driver |
| kernel capabilities it can grant (`caps`) | none are enforced today (section 8) |
| cost of a restore | measured only for the API call (8 ms), not the guest |

Resource admission is the orchestrator's job (`planPlacement()`): the driver
does not know how many vcpus the machine has.

## 3. Artefacts

| Artefact | Source | Notes |
| --- | --- | --- |
| `firecracker`, `jailer` | the project's release tarball | pinned by version and checksum by the operator; the jailer needs root to start and drops to an unprivileged uid |
| guest kernel (`vmlinux`) | a Firecracker CI artifact, or built from the project's `resources/guest_configs` | uncompressed; read-only to the VMM inside the jail (`0400`) |
| base rootfs (`rootfs.ext4`) | `guest/build-rootfs.sh` (Alpine, Node, `socat`, `ServerPod`) | **a shared base**: never attached to a VM; each pod gets a private copy inside its jail (`cp --reflink=auto --no-clobber`, mode `0600`, owned by the VMM uid) |
| snapshot files | written by Firecracker (`vmstate`, `mem`) inside the jail | contain the guest's whole memory, including its identity key: treat as secret; owned by the VMM uid |

`guest/build-rootfs.sh` has never been executed (needs root, loop mounts).

## 4. The jailer

`VmPodHost.spawn()` starts every VM through the jailer, daemonized, via
`VmPod`'s `vmmArgv` (so `restore()` can start a fresh VMM; the VMM is gone
after `snapshot()`):

- **Identity.** `--uid/--gid` are never 0. Default: `100000 + vsock CID`, a
  different identity per VM (`uidBase`/`gidBase` configurable). An explicit
  `uid`/`gid` is the operator's choice and is shared by every VM, which gives
  up the per-VM separation. `buildJailerArgv()` rejects 0.
- **Chroot.** `<base>/<exec file name>/<id>/root`. Inside it Firecracker's
  filesystem root is that directory, so the API is given *relative* names
  (`vmlinux`, `rootfs.ext4`, `v.sock`, `vmstate`, `mem`) while the host
  reaches the same files under the chroot's `root`. `vm-config.mjs`
  (`chrootLayout`, `planChrootStaging`) is that mapping; the jailer does not
  copy resources in, so `VmPod.boot()` stages the kernel and the private
  rootfs copy **after** the jailer has created the chroot and **before** the
  first API call.
- **cgroups (v2)** for the VMM process: `cpu.max` for the vcpus,
  `memory.max` for guest memory plus 64 MiB of VMM overhead, `pids.max` of
  vcpus + 32 (`cgroupsFor()`). The numbers are a starting point, unmeasured.
- **Stopping the VMM** is by the pid the jailer records (`<exec name>.pid` in
  the chroot root, `jailerPidFilePath()`), and only after the process's
  command line is checked to carry exactly `--id <this id>`
  (`vmmCommandLineMatches()`: an id that is a prefix or suffix of another
  pod's id does not match it, a stale pid that was reused does not match).
- Not used yet: `--netns` (one network namespace per VM would remove the
  host-wide nft table dependence), `--new-pid-ns`, `--resource-limit`
  (`fsize`, `no-file`). Jailer's seccomp filter for Firecracker is its
  default (level 2) and has not been adjusted.

## 5. Network path

Per pod, `network-policy.mjs` builds the host commands: a TAP device
(`tap-` + 10 hex of the pod name's SHA-256, because Linux interface names
are 15 characters), a `/30` from `10.200.0.0/16` (host `.1`, guest `.2`),
and **one nft table `fc-<id>`** holding:

- `input`: everything from the TAP dropped (the guest reaches no service on
  the host);
- `forward`: IPv6 dropped; source address and MAC pinned to the guest's;
  operator `allowCidrs` accepted first; then private, loopback, link-local
  (so the metadata address), CGNAT, multicast and reserved destinations
  dropped; other egress via the uplink accepted; anything else from the TAP
  dropped; into the TAP only replies;
- `postrouting`: masquerade for the guest's address.

Modes: `public` (default), `allowlist` (only `allowCidrs`), `none`.
Teardown is `nft delete table inet fc-<id>`, which cannot touch another pod.
A failing host command aborts the boot (no VM starts without its rules).

Firecracker's own rate limiters (`limits.netRateLimiter`,
`limits.blockRateLimiter`) are passed through to the network interface and
the drive.

Open: the guest needs a **resolver**. The default policy drops private
destinations, so a LAN resolver is unreachable and `guest/init` configures
none; a `signaling_url` with a host name needs one. Today use an IP address
or allow a resolver with `allowCidrs`.

## 6. Transport path: how a pod talks

- **Mesh.** The guest's `ServerPod` registers over the TAP with the signaling
  or relay server named by `signaling_url` on the kernel command line
  (`buildBootArgs()`; ws/wss, no credentials, no query: the command line is
  readable through the Firecracker API). WebRTC to browsers goes through the
  host's NAT like any Node peer.
- **Host control.** `exec` goes over vsock: the host connects to
  `<jail root>/v.sock`, writes `CONNECT 52`, then `EXEC <base64 argv>`; the
  guest's `socat VSOCK-LISTEN:52 ... UNIX-CONNECT:/run/vsock-exec.sock`
  bridges to `guest/vsock-exec-responder.mjs` (Node has no `AF_VSOCK`).
  `vsock-bridge.mjs` is the host half. `send` is not implemented.
- The guest boots `ip=<guest>::<gateway>:<mask>::eth0:off`; `guest/init`
  converts the dotted mask to a prefix and configures `eth0` by hand.

## 7. Lifecycle, snapshot and restore

`VmPod` is the §5.3 state machine of the issue, and `VmPodHost`/the driver
map it 1:1 onto `POD_LIFECYCLE`:

```
cold -> booting -> registered <-> serving
registered -> paused -> snapshotted -> restoring -> registered
registered -> draining -> cold            (the pod's rootfs copy is kept)
```

- **Boot:** (outside the jail) none; start VMM; stage jail; install network;
  `PUT /machine-config` (with `track_dirty_pages: true`, required for a
  restorable snapshot), `/boot-source`, `/drives/rootfs`,
  `/network-interfaces/eth0`, `/vsock`, `/actions InstanceStart`. The pod
  reaches `registered` when the guest announces itself.
- **Snapshot:** `PATCH /vm Paused`, `PUT /snapshot/create` (Full), stop the
  VMM by pid. The TAP and its rules stay.
- **Restore:** remove then reinstall the network (tolerating "not there"),
  unlink the stale vsock socket (Firecracker refuses to bind over it), start
  a **fresh** VMM, `PUT /snapshot/load` (`mem_backend: File`), `PATCH /vm
  Resumed`.
- **Drain:** stop the VMM, remove the network, back to `cold`.

Constraints a deployer must know: a snapshot carries the guest's identity
key and memory, so **restoring the same snapshot twice yields two pods with
one identity** (nothing prevents it today; a restore should consume the
snapshot or the guest must re-key on resume); the guest's clock resumes where
it stopped.

## 8. Resource limits and kernel capabilities

| podspec / `KERNEL_CAP` | Enforced by | State |
| --- | --- | --- |
| `limits.vcpus`, `limits.memMib` | `machine-config` and the jailer cgroups | built, fake-API tested |
| `limits.netRateLimiter`, `limits.blockRateLimiter` | Firecracker rate limiters | passed through, fake-API tested |
| `limits.timeoutMs` | not enforced by this driver | not done |
| `caps` (NET, FS, CLOCK, IPC, STDIO, MESH, ENV, ...) | **nothing**: the driver accepts and ignores them | not done; the nft policy and the guest's contents are what actually bound the guest |
| `env` | not passed to the guest | not done (the kernel command line is not a secret channel) |

## 9. The security boundary claimed

Claimed: a hosted pod runs as untrusted code inside a KVM guest. It cannot
reach the host's files, memory or processes except through the VMM's device
emulation (virtio-net, virtio-block, vsock, the serial console), and a VMM
escape lands in an unprivileged, per-VM identity inside a chroot with a
cgroup and the jailer's seccomp filter. It cannot reach the host's own
network services, the LAN, other pods or the metadata address under the
default egress policy, and cannot spoof another pod's addresses.

Not claimed: protection from a Firecracker/KVM escape, CPU side channels
between guests on shared cores, resource exhaustion beyond the cgroup limits,
denial of service on the host's network by an allowed flow, or confidentiality
against the host operator (who can read guest memory and the snapshot).
"Hardware boundary" is the *kind* of boundary, not a guarantee of its
strength; see `docs/design/hosted-pods-security-review.md`.

## 10. The `test:real-firecracker` script

`npm run test:real-firecracker` (root) or `npm run test:real-firecracker` in
`spikes/vm-pod-host`, following the repository's `test:real-*` convention:
**opt-in and not part of `npm test` or CI.** It needs a Linux/KVM host, root,
`ip` and `nft`, and `FIRECRACKER_BIN`, `JAILER_BIN`, `FC_KERNEL`, `FC_ROOTFS`
(a rootfs from `guest/build-rootfs.sh`). Without them it skips and reports
success; `REQUIRE_REAL_FIRECRACKER=1` makes a missing prerequisite fail.
It boots one jailed VM and checks: exec over vsock works; boot-to-exec and
restore-to-exec timings (printed); guest state survives snapshot and restore;
the guest cannot reach `169.254.169.254` or the host's TAP address; drain
leaves no VMM and no nft table. **It has never been run.**

## 11. Verification status

| Piece | Built | Tested here | Run on a real host |
| --- | --- | --- | --- |
| Firecracker API client | yes | against the fake API | yes (1.16.1, once, no jailer) |
| API call order and bodies for boot, snapshot, restore | yes | against the fake API over a unix socket (`lifecycle-fake-api.test.mjs`) | no |
| jailer argv, uid policy, cgroups, chroot layout and staging | yes | as argv/commands | no |
| network policy (nft) | yes | as argv/commands | no |
| stopping the VMM by pid with an id check | yes | with a fake process table | no |
| vsock `exec` | yes | against a fake vsock socket | no |
| guest `init`, exec responder, `build-rootfs.sh` | yes | syntax/shell function only | no |
| guest registering over signaling | n/a | no | no |
| snapshot/restore of a real guest, timings | n/a | no | partly (API only) |

## 12. What remains, and needs a Linux/KVM host

1. Run `test:real-firecracker` and fix what it finds (jailer pid file name and
   location; whether the jailer accepts a chroot left by a previous run on
   restore; the `cp`/`chown` staging against real mounts; the nft grammar;
   `ether saddr` matching on the forward hook).
2. Build the rootfs and boot the guest to `registered` over signaling;
   measure boot-to-registered and restore-to-registered.
3. A resolver for the guest.
4. One network namespace per VM; `--new-pid-ns`; jailer resource limits.
5. Make a restore single-use or re-key the guest; enforce `limits.timeoutMs`
   and `caps`.
6. `send` over vsock.
