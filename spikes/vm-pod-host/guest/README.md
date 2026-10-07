# vm-pod-host guest image

This directory holds everything needed to build the guest side of a
Firecracker microVM pod: `init` (PID 1), `vsock-exec-responder.mjs` (the
exec bridge), and `build-rootfs.sh` (turns both, plus
`browsermesh-servers/kernel`, into a `rootfs.ext4`).

**None of this has been run.** The dev machine this was written on is
macOS with no `/dev/kvm`, no loop-mount support, and no Firecracker. All
three files are source, reviewed for correctness against the Firecracker
docs, but not executed end-to-end. See the top-level `README.md` for the
honest "what ran / what didn't" summary.

## Getting a guest kernel (`vmlinux`)

Firecracker does not ship a kernel — you need an uncompressed,
ELF-format `vmlinux` built with (or compatible with) Firecracker's
minimal virtio device set. Two options, per the Firecracker `main`
branch's `docs/getting-started.md`:

1. **Fetch a CI-built one.** Firecracker's own CI publishes `vmlinux`
   binaries to the public S3 bucket `spec.ccfc.min` under the
   `firecracker-ci/` prefix, one per supported kernel version/arch. The
   getting-started guide includes a small script that lists that
   bucket, picks the newest `firecracker-ci/<version>/<arch>/vmlinux-*`
   object, and downloads it — see
   `https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md`
   for the current script (the exact bucket layout has changed over
   Firecracker's history, so copy it from there rather than from this
   file).
2. **Build your own.** Firecracker publishes known-good kernel configs
   under `resources/guest_configs/` in its own repo
   (`https://github.com/firecracker-microvm/firecracker/tree/main/resources/guest_configs`);
   use one of those as a starting `.config` for a mainline kernel build
   if you need modules or kernel options the CI binary doesn't have.

Either way, drop the result at the path you'll pass to
`VmPod`/`cli.mjs` as `kernelImage` (default in this spike's CLI:
`/boot/vmlinux`).

## Building the rootfs

```sh
git clone git@github.com:johnhenry/browsermesh-servers.git /tmp/browsermesh-servers
KERNEL_SRC_DIR=/tmp/browsermesh-servers/kernel \
  sudo ./build-rootfs.sh ./rootfs.ext4
```

Requires root (loop-mount + chroot), `mkfs.ext4`, and `npm`. Produces a
512MB (configurable via `ROOTFS_SIZE_MB`) ext4 image with Alpine Linux,
Node (via `apk add nodejs`), `iproute2`, `socat`, this directory's
`init` as `/init`, and `browsermesh-servers/kernel` (with its own
`node_modules`) under `/opt/browsermesh-servers/kernel`.

## Boot args this guest expects

Set via `putBootSource({ boot_args })` in `src/vm-pod.mjs`:

```
console=ttyS0 reboot=k panic=1 root=/dev/vda rw init=/init \
  ip=<guest-ip>::<gateway-ip>:<netmask>::eth0:off \
  signaling_url=ws://<host-tap-ip>:8787
```

`init` parses `ip=` and `signaling_url=` out of `/proc/cmdline` itself —
see the comment block at the top of `init` for why (no MMDS configured
in this spike, so cmdline is the only pre-boot channel into the guest).
