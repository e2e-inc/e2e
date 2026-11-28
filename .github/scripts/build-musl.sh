#!/bin/sh
# Builds a native addon for a musl target inside an Alpine container, where
# the addon links the musl a user's Node there runs on, and checks the build
# and leaves it in its package for the next step to load. The workflow runs it as
#   docker run --rm -v "$PWD:/work" -w /work node:<version>-alpine@<digest> sh .github/scripts/build-musl.sh <addon> <target>
# on a runner of the target's architecture.
#
# rustup-init is a fixed release checked against the SHA-256 recorded here,
# the same version `.github/actions/rust-toolchain` pins for the other runners.
set -eu

addon="$1"
target="$2"
RUSTUP_VERSION=1.29.3
case "$(uname -m)" in
  x86_64) host=x86_64-unknown-linux-musl sha256=1552169aba2836777136ccff7a381e95c17233b5d8250cd5e10ae3cb971bfcfc ;;
  aarch64) host=aarch64-unknown-linux-musl sha256=956deacdc27ab82ae7ac821d5d3e9e95e4795d476d17efe99743bb8531ca1031 ;;
  *) echo "no pinned rustup-init for $(uname -m)" >&2; exit 1 ;;
esac
if [ "$host" != "$target" ]; then
  echo "$target builds on a runner of its own architecture, not $host" >&2
  exit 1
fi

# The linker and C runtime objects a cdylib needs.
apk add --no-cache build-base curl
curl --proto '=https' --tlsv1.2 -sSf --retry 3 -o /tmp/rustup-init \
  "https://static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/$host/rustup-init"
echo "$sha256  /tmp/rustup-init" | sha256sum -c -
chmod +x /tmp/rustup-init
/tmp/rustup-init -y --no-modify-path --default-toolchain none
export PATH="$HOME/.cargo/bin:$PATH"

node scripts/native/build-native.ts "$addon" --target "$target"
node scripts/native/check-build.ts "$addon" "$target"
