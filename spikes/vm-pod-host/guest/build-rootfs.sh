#!/bin/sh
# guest/build-rootfs.sh — build rootfs.ext4 for the vm-pod-host demo
# guest: Alpine Linux minirootfs + Node 26 + browsermesh-servers/kernel.
#
# NOT executed by this spike (requires root, loop devices, and Linux —
# none available on the macOS dev machine this was written on; see the
# top-level README.md "what was and wasn't run" section). Written,
# reviewed, and intended to be run on a real Linux build host (can be
# the same KVM host you'll run Firecracker on, or any Linux box — this
# script only needs loop-mount + chroot, not KVM) as the first step of
# the runbook.
#
# Follows the approach from the Firecracker `main` branch's
# docs/getting-started.md ("Build your own guest rootfs"): download a
# distro's minimal userland tarball, unpack it onto a loop-mounted ext4
# image, chroot in to install packages, then unmount. We use Alpine
# (musl, ~3MB base) instead of Firecracker's own Ubuntu squashfs example
# because it is dramatically smaller and we only need Node + a shell +
# iproute2 + socat, not a full distro.
#
# Usage:
#   sudo ./build-rootfs.sh [output-path]   # default: ./rootfs.ext4
#
# Result: an ext4 image containing:
#   /init                                        (this dir's init script, PID 1)
#   /opt/vsock-exec-responder.mjs                (this dir's responder)
#   /opt/browsermesh-servers/kernel/*.mjs         (copied from the sibling repo)
#   /usr/bin/node                                 (Node 26, via Alpine's nodejs-current)
#   busybox userland + iproute2 + socat

set -eu

ALPINE_VERSION="3.20"
ALPINE_ARCH="$(uname -m)"
OUTPUT="${1:-./rootfs.ext4}"
SIZE_MB="${ROOTFS_SIZE_MB:-512}"

# Resolve the sibling browsermesh-servers checkout the agent cloned for
# reading reference (see WP3 task rules: it is NOT committed to this
# repo). A real build must point this at a real checkout, e.g.:
#   KERNEL_SRC_DIR=/path/to/browsermesh-servers/kernel ./build-rootfs.sh
KERNEL_SRC_DIR="${KERNEL_SRC_DIR:-../browsermesh-servers/kernel}"

if [ ! -f "${KERNEL_SRC_DIR}/index.mjs" ]; then
  echo "error: ${KERNEL_SRC_DIR}/index.mjs not found." >&2
  echo "       set KERNEL_SRC_DIR to a browsermesh-servers checkout, e.g.:" >&2
  echo "       git clone git@github.com:johnhenry/browsermesh-servers.git /tmp/browsermesh-servers" >&2
  echo "       KERNEL_SRC_DIR=/tmp/browsermesh-servers/kernel ./build-rootfs.sh" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'umount "${WORK}/mnt" 2>/dev/null || true; rm -rf "${WORK}"' EXIT

echo "==> fetching Alpine minirootfs ${ALPINE_VERSION} (${ALPINE_ARCH})"
ALPINE_MINOR="$(echo "$ALPINE_VERSION" | cut -d. -f1-2)"
curl -fsSL -o "${WORK}/alpine-minirootfs.tar.gz" \
  "https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_MINOR}/releases/${ALPINE_ARCH}/alpine-minirootfs-${ALPINE_VERSION}.0-${ALPINE_ARCH}.tar.gz"

echo "==> creating ${SIZE_MB}MB ext4 image at ${OUTPUT}"
dd if=/dev/zero of="${OUTPUT}" bs=1M count="${SIZE_MB}" status=none
mkfs.ext4 -q "${OUTPUT}"

mkdir -p "${WORK}/mnt"
mount -o loop "${OUTPUT}" "${WORK}/mnt"

echo "==> unpacking Alpine base"
tar -xzf "${WORK}/alpine-minirootfs.tar.gz" -C "${WORK}/mnt"

echo "==> installing packages (nodejs, iproute2, socat) in chroot"
cp /etc/resolv.conf "${WORK}/mnt/etc/resolv.conf"
chroot "${WORK}/mnt" /sbin/apk update
chroot "${WORK}/mnt" /sbin/apk add --no-cache nodejs iproute2 socat

echo "==> installing init and vsock exec responder"
install -m 755 "$(dirname "$0")/init" "${WORK}/mnt/init"
mkdir -p "${WORK}/mnt/opt/browsermesh-servers/kernel"
install -m 644 "$(dirname "$0")/vsock-exec-responder.mjs" "${WORK}/mnt/opt/vsock-exec-responder.mjs"

echo "==> installing kernel's own npm deps (browsermesh-pod, browsermesh-primitives, ws, multicast-dns)"
if [ ! -d "${KERNEL_SRC_DIR}/node_modules" ]; then
  ( cd "${KERNEL_SRC_DIR}" && npm install --omit=dev )
fi

echo "==> copying browsermesh-servers/kernel (incl. node_modules) from ${KERNEL_SRC_DIR}"
cp -R "${KERNEL_SRC_DIR}/." "${WORK}/mnt/opt/browsermesh-servers/kernel/"

echo "==> done: ${OUTPUT}"
echo "    boot it with boot_args:"
echo '    console=ttyS0 reboot=k panic=1 root=/dev/vda rw init=/init ip=172.16.0.2::172.16.0.1:255.255.255.252::eth0:off signaling_url=ws://172.16.0.1:8787'
