#!/bin/sh
# Builds a native addon for a glibc target inside a manylinux_2_28 container
# (AlmaLinux 8, glibc 2.28), so the addon asks for no glibc newer than 2.28,
# the oldest that Node 22's and 24's own Linux builds run on (Debian 11,
# Ubuntu 20.04, RHEL 8). It checks the build, leaves it in its package, and,
# given a probe script and its arguments, runs that in the same container,
# so the addon is loaded on glibc 2.28 itself. The workflow runs it as
#   docker run --rm -v "$PWD:/work" -w /work quay.io/pypa/manylinux_2_28_<arch>@<digest> sh .github/scripts/build-glibc.sh <addon> <target> [<probe> <args>...]
# on a runner of the target's architecture.
#
# rustup-init is a fixed release checked against the SHA-256 recorded here,
# the same version `.github/actions/rust-toolchain` pins for the other runners.
# The image has no Node, so the scripts run in Node's official build, a fixed
# release checked against the SHA-256 in https://nodejs.org/dist/v<version>/SHASUMS256.txt.
set -eu

addon="$1"
target="$2"
shift 2
RUSTUP_VERSION=1.29.3
NODE_VERSION=26.13.1
case "$(uname -m)" in
  x86_64)
    host=x86_64-unknown-linux-gnu rustup_sha256=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55
    node_arch=x64 node_sha256=518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778 ;;
  aarch64)
    host=aarch64-unknown-linux-gnu rustup_sha256=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282
    node_arch=arm64 node_sha256=80a330b35415382878df18d41afbd106ea89bfb3be0087d6608e289a14c5cc7d ;;
  *) echo "no pinned rustup-init or Node for $(uname -m)" >&2; exit 1 ;;
esac
if [ "$host" != "$target" ]; then
  echo "$target builds on a runner of its own architecture, not $host" >&2
  exit 1
fi

curl --proto '=https' --tlsv1.2 -sSf --retry 3 -o /tmp/rustup-init \
  "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/$host/rustup-init"
echo "$rustup_sha256  /tmp/rustup-init" | sha256sum -c -
chmod +x /tmp/rustup-init
/tmp/rustup-init -y --no-modify-path --default-toolchain none
export PATH="$HOME/.cargo/bin:$PATH"

node_dir="node-v$NODE_VERSION-linux-$node_arch"
curl --proto '=https' --tlsv1.2 -sSf --retry 3 -o "/tmp/$node_dir.tar.gz" \
  "https://nodejs.org/dist/v$NODE_VERSION/$node_dir.tar.gz"
echo "$node_sha256  /tmp/$node_dir.tar.gz" | sha256sum -c -
tar -xzf "/tmp/$node_dir.tar.gz" -C /tmp
export PATH="/tmp/$node_dir/bin:$PATH"

node scripts/native/build-native.ts "$addon" --target "$target"
node scripts/native/check-build.ts "$addon" "$target"
if [ "$#" -gt 0 ]; then
  node "$@"
fi
