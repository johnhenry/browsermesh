# Runbook: the microVM lane on a Linux/KVM host

The one thing left of the microVM lane ([#185](https://github.com/johnhenry/browsermesh/issues/185),
[#221](https://github.com/johnhenry/browsermesh/issues/221)) is to run it on a machine that has KVM. This is the whole
checklist, in order. Everything that can run without KVM already has: the Firecracker API client (once, against a real
Firecracker 1.16.1), the lifecycle against a fake API, the network policy against a real Linux kernel, the guest's exec
responder as a process. What follows is what none of that can show: the jailer, the real TAP device carrying real
packets, the guest image booting, the guest registering, a snapshot restored for real, and the three numbers of issue
\#185 section 9.

Design and what is claimed: [`design/hosted-pods-firecracker.md`](design/hosted-pods-firecracker.md). Spike layout:
[`spikes/vm-pod-host/README.md`](../spikes/vm-pod-host/README.md).

**How to read the outputs below.** "Expected" output is what the commands and the test code print when it works. Only the
lines marked *(observed)* were seen on a machine; the rest is derived from the code and has not been run on KVM. If
something differs, that is the finding: write it into the issue rather than adjusting the runbook to match.

## 0. What is already verified without KVM

| Piece | Checked how | Where |
| --- | --- | --- |
| Firecracker API client | against a real Firecracker 1.16.1 once (no jailer, busybox initramfs), and against a fake API on a unix socket | `spikes/vm-pod-host/README.md` "Measurements"; `test/firecracker-client.test.mjs` |
| API call order and bodies for boot, snapshot, restore, drain | fake API on a unix socket, recorded host commands | `test/lifecycle-fake-api.test.mjs` |
| nft rules and the TAP device | applied to a real Linux kernel (a container with `NET_ADMIN`): a guest network namespace behind them cannot reach a metadata or private address, the host's own TAP address, or spoof its source IP or MAC; an allow-list entry and the modes `allowlist` and `none` do what they say; teardown removes the pod's table only; a real TAP is created and removed | `test/real/network-policy.real.test.mjs` (`npm run test:real-linux-network`) *(observed, Linux arm64 under Docker, Node 26.13.1, nft 1.0.6)* |
| the guest's exec responder and the host's exec client | the responder run as a process, the client talking to it through a stand-in for the vsock proxy | `test/guest-responder.test.mjs` |
| the guest scripts parse | `sh -n` | `test/guest-scripts.test.mjs` |
| the whole `spikes/vm-pod-host` suite | passes on macOS arm64 and on Linux arm64 (glibc, Node 26.13.1) | `npm test` in `spikes/vm-pod-host` |

KVM is not available in Docker Desktop's VM: `docker run --device /dev/kvm` fails with "no such file or directory"
there. That was checked, so do not spend time on a laptop.

## 1. The host

A Linux machine, x86_64 or aarch64, with working KVM, root, and outbound internet for the downloads. Bare metal, or a
virtual machine with nested virtualisation enabled. Debian 12 / Ubuntu 22.04 or later are the least surprising.

```sh
uname -sm                         # Linux x86_64   (or: Linux aarch64)
ls -l /dev/kvm                    # crw-rw---- 1 root kvm ... /dev/kvm   (must exist)
id -u                             # 0 inside `sudo -i`, or use sudo for every command below
```

Stop here if `/dev/kvm` is missing: the machine cannot run Firecracker (this is the check that failed in Docker Desktop).
On x86_64, `grep -c -E 'vmx|svm' /proc/cpuinfo` must print a number greater than 0; on a cloud VM it is 0 unless nested
virtualisation is on.

Packages (Debian/Ubuntu):

```sh
apt-get update
apt-get install -y curl git e2fsprogs iproute2 nftables socat procps ca-certificates
```

Node 26 or later and npm (the repository's `engines`); use whatever installs it on that distribution, then:

```sh
node --version                    # v26.x.x
```

Forwarding must be on (`VmPod` creates the TAP, its address and its nft table itself, but not this):

```sh
sysctl -w net.ipv4.ip_forward=1   # net.ipv4.ip_forward = 1
```

## 2. Firecracker and the jailer, pinned

1.16.1 is the version the client was run against. The checksums are from the release's own `.sha256.txt` files.

```sh
ARCH=$(uname -m)                  # x86_64 or aarch64
mkdir -p /opt/fc && cd /opt/fc
curl -fsSLO "https://github.com/firecracker-microvm/firecracker/releases/download/v1.16.1/firecracker-v1.16.1-${ARCH}.tgz"
case "$ARCH" in
  x86_64)  echo "382a02a869e4d6d5cb14c40577f9545e8458021ea8b0b2d3fc10ec14d9c242e6  firecracker-v1.16.1-x86_64.tgz"  | sha256sum -c - ;;
  aarch64) echo "8d0e69f6d6f9a1724551f607f18504052c16c1828ee3d4d7b6e6c73380871e0e  firecracker-v1.16.1-aarch64.tgz" | sha256sum -c - ;;
esac                              # firecracker-v1.16.1-<arch>.tgz: OK
tar xzf "firecracker-v1.16.1-${ARCH}.tgz"
install -m 755 "release-v1.16.1-${ARCH}/firecracker-v1.16.1-${ARCH}" /usr/local/bin/firecracker
install -m 755 "release-v1.16.1-${ARCH}/jailer-v1.16.1-${ARCH}"      /usr/local/bin/jailer
firecracker --version             # Firecracker v1.16.1
jailer --version                  # Jailer v1.16.1
```

(The directory and file names inside the tarball follow Firecracker's own release layout; if `install` cannot find them,
`ls release-*` shows the names. That is the one line here not derived from a log.)

## 3. A guest kernel

An uncompressed `vmlinux` from Firecracker's CI bucket. The newest prefix with kernels in it is `v1.15` (the bucket has no
`v1.16` or later prefix at the time of writing); 6.1 is the kernel line the first real run used.

```sh
cd /opt/fc
case "$(uname -m)" in
  x86_64)  K=firecracker-ci/v1.15/x86_64/vmlinux-6.1.155;  SUM=e20e46d0c36c55c0d1014eb20576171b3f3d922260d9f792017aeff53af3d4f2 ;;  # 44279576 bytes, ELF
  aarch64) K=firecracker-ci/v1.15/aarch64/vmlinux-6.1.155; SUM=e3544b10603acbf3db492cb52e000d22ba202cb4b63b9add027565683e11c591 ;;  # 17111552 bytes, arm64 Image
esac
curl -fsSL -o vmlinux "https://s3.amazonaws.com/spec.ccfc.min/${K}"
echo "${SUM}  vmlinux" | sha256sum -c -      # vmlinux: OK
```

Both checksums and sizes were taken by downloading those objects. If the bucket layout has changed, copy the current
download steps from Firecracker's `docs/getting-started.md` instead (see `spikes/vm-pod-host/guest/README.md`).

## 4. The repository and the guest rootfs

```sh
git clone https://github.com/johnhenry/browsermesh.git /opt/browsermesh
git clone https://github.com/johnhenry/browsermesh-servers.git /opt/browsermesh-servers
cd /opt/browsermesh && git log -1 --format=%H     # record this commit in the issue
```

The rootfs build needs root, loop devices, `mkfs.ext4` and `chroot`, and downloads Alpine 3.20's minirootfs and its
packages. It builds on the same host. The image's Node is whatever Alpine's `nodejs` package is for the release used:
20.15.1 on the script's default (Alpine 3.20), 22.x on 3.22, 24.x on 3.23 (Alpine's package indexes, checked at the time
of writing; only `edge` has 26). The packages in this repository declare Node 26 or later, so a Node 20 guest is a guess;
start with 3.23 (its minirootfs exists for 3.23.0, checked).

```sh
cd /opt/browsermesh
ALPINE_VERSION=3.23 ALPINE_RELEASE=3.23.0 KERNEL_SRC_DIR=/opt/browsermesh-servers/kernel \
  spikes/vm-pod-host/guest/build-rootfs.sh /opt/fc/rootfs.ext4
```

Expected (the `==>` lines are the script's own, in this order; the Node line is the one the script prints from inside the
image):

```
==> fetching Alpine minirootfs 3.23 (x86_64)
==> creating 512MB ext4 image at /opt/fc/rootfs.ext4
==> unpacking Alpine base
==> installing packages (nodejs, iproute2, socat) in chroot
    node in the image: v24.x.x
==> installing init and vsock exec responder
==> installing kernel's own npm deps (browsermesh-pod, browsermesh-primitives, ws, multicast-dns)
==> copying browsermesh-servers/kernel (incl. node_modules) from /opt/browsermesh-servers/kernel
==> done: /opt/fc/rootfs.ext4
```

Then, outside the image:

```sh
ls -lh /opt/fc/rootfs.ext4                    # 512M
e2fsck -fn /opt/fc/rootfs.ext4                # ... clean, ... files, ... blocks
```

Things this step is likely to hit, in order of likelihood: the guest's Node being older than the packages expect (the
line printed above, and the next command; leave `ALPINE_VERSION` unset to compare against the default's Node 20); the
kernel directory
pins `@johnhenry/browsermesh-pod ^0.2.0`, which is older than the repository's current pod package (a guest on the old pod
may not speak the current discovery messages; that is the sibling repository's to update); `apk` cannot resolve a name
(the chroot copies the host's `/etc/resolv.conf`; a stub resolver address like `127.0.0.53` does not work inside it).

```sh
mkdir -p /mnt/rootfs && mount -o loop,ro /opt/fc/rootfs.ext4 /mnt/rootfs
chroot /mnt/rootfs /usr/bin/node --version    # v2x.x.x or later
ls /mnt/rootfs/init /mnt/rootfs/opt/vsock-exec-responder.mjs /mnt/rootfs/opt/browsermesh-servers/kernel/index.mjs
umount /mnt/rootfs
```

## 5. A signalling server the guest can reach

The guest registers with the signalling server named on its kernel command line. Under the default egress policy it can
reach **public addresses only**, never the host or the LAN, and it has **no resolver** (use an IP address, not a name). So
run a signalling server on a machine with a public address, or add the address to the driver's allow list
(`network: { egress: { allowCidrs: ['203.0.113.7/32'] } }`; the real test does not set this, so use a public one for it).

Open-mode server from the sibling repository, on that machine:

```sh
cd /opt/browsermesh-servers/signaling && npm install --omit=dev && node index.mjs   # port 8787
```

Export its address for the test: `export FC_SIGNALING_URL=ws://203.0.113.7:8787` (an IP, ws or wss, no credentials, no
query: the command line is readable through the Firecracker API).

## 6. Run the real test

```sh
cd /opt/browsermesh
npm ci
sudo env "PATH=$PATH" \
  FIRECRACKER_BIN=/usr/local/bin/firecracker JAILER_BIN=/usr/local/bin/jailer \
  FC_KERNEL=/opt/fc/vmlinux FC_ROOTFS=/opt/fc/rootfs.ext4 \
  FC_SIGNALING_URL="$FC_SIGNALING_URL" REQUIRE_REAL_FIRECRACKER=1 \
  npm run test:real-firecracker
```

`REQUIRE_REAL_FIRECRACKER=1` makes a missing prerequisite a failure, not a skip. Expected when everything works:

```
▶ real Firecracker: one jailed microVM, end to end
  ✔ boots under the jailer and answers an exec over vsock
  ✔ keeps guest state across snapshot and restore
  ✔ cannot reach the cloud metadata address or the host itself
  ✔ leaves no VMM process and no nft table behind after drain
real Firecracker timings (ms; vmmRssKb is kB): {"bootToExecMs":<n>,"vmmRssKb":<n>,"restoreToExecMs":<n>}
```

Those three numbers are the measurements issue #185 section 9 asks for (boot to a working guest, memory of the VMM
process, snapshot restore to a working guest). Targets there: boot under 1 s, restore under 300 ms, under 40 MB.
Record them, with the kernel, the Firecracker version and the machine, in the issue and in
`spikes/vm-pod-host/README.md` "Measurements".

This test has never run against a real Firecracker. The first run will probably find something; the places to look first
are the ones `design/hosted-pods-firecracker.md` section 12 lists: the jailer's pid file name and location (the test
reads `<chroot base>/firecracker/realfc/root/firecracker.pid`), whether the jailer accepts a chroot left by an earlier
run, the `cp`/`chown` staging against real mounts, and the cgroup v2 limits (`mount | grep cgroup2` must show a cgroup2
mount; otherwise the jailer fails at start with a message naming it).

A failure that leaves things behind is cleaned up by hand:

```sh
pgrep -af firecracker ; nft list tables ; ip -br link | grep '^tap-'
# then: kill <pid started by the test>; nft delete table inet fc-realfc; ip link del tap-<hash>; rm -rf /tmp/real-fc-*
```

## 7. The guest registers over signalling (not asserted by the test)

The test marks the pod registered itself and talks over vsock. That the guest's `ServerPod` really registers with the
signalling server, which is the "boot to registered" figure, is checked by looking. While the test is in its first step
(or after a manual `spawn`), from any machine, ask the signalling server who is connected:

```sh
node -e '
const ws = new WebSocket(process.argv[1]);
ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "register", podId: "bm-check" })));
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.type === "peers") { console.log(JSON.stringify(m)); ws.close(); process.exit(0) } });
setTimeout(() => process.exit(1), 10000)' "$FC_SIGNALING_URL"
```

Expected: one line, `{"type":"peers","peers":["...","bm-check"]}`: the guest's pod id is the other entry *(the line's shape was
observed against this repository's signalling test double; against the real server in authenticated mode, which needs a
signed registration, read its log instead)*. The time from the test starting the VM to that entry appearing is the
boot-to-registered figure.

## 8. What to report

Paste into #221 / #185, one line each, pass or the exact output that failed:

1. host: `uname -a`, `firecracker --version`, kernel file and sha256, repository commit, `browsermesh-servers` commit;
2. section 4: rootfs built, Node version inside it;
3. section 6: the four test results and the timings line;
4. section 7: the guest's pod id seen in `peers`;
5. anything the first run found, with the failing command and its output.

Then the items below can be ticked: Firecracker full lifecycle on a real host (jailer, TAP/nft, `build-rootfs.sh`, guest
registration), and the `VmPod.restore()` fixes confirmed against a real VMM.

Not covered by this runbook, on purpose: running more than one VM at a time, a restore of the same snapshot twice (which
yields two pods with one identity; see the design note), a resolver for the guest, one network namespace per VM, jailer
resource limits, and `limits.timeoutMs`/`caps` enforcement. Those are listed in `design/hosted-pods-firecracker.md`
section 12 and are separate work.
