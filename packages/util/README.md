# @e2e-dev/util

Native utilities for [e2e](https://github.com/e2e-inc/e2e): work that would
block the JavaScript thread, done in Rust and run on a native worker pool.
The first job is image processing: PNG decoding and encoding, box
resampling, cropping, masking, and screenshot comparison (a bit-exact port
of pixelmatch 8).

e2e depends on this package. You do not need to install it yourself.

## How it works

- The logic is the `e2e-util` crate (`crates/e2e-util`), plain Rust with no
  binding dependency. The Node addon is `crates/e2e-util-napi`, built with
  NAPI-RS.
- Decoding, encoding, resizing, cropping, painting, and comparing return a
  Promise. The work runs on a blocking thread of NAPI-RS's tokio runtime, at
  most one call per core. Two calls copy a whole image on the JavaScript
  thread: `NativeImage.fromRgba` copies its input, and `pixels()` copies the
  image out.
- A decoded image stays on the native side as a `NativeImage`. V8 is told
  how much memory it holds, so many images in a row press the garbage
  collector as their memory does.
- The addon loads on the first call, not on import. A checkout build
  (`util.<platform>.node` in this directory) is tried first, then the
  platform package `@e2e-dev/util-<platform>`, which npm installs with this
  package on its platform.

## Platforms

| Platform | Package |
| --- | --- |
| macOS, Apple silicon | `@e2e-dev/util-darwin-arm64` |
| macOS, Intel | `@e2e-dev/util-darwin-x64` |
| Linux x64, glibc 2.35 or later | `@e2e-dev/util-linux-x64-gnu` |
| Linux arm64, glibc 2.35 or later | `@e2e-dev/util-linux-arm64-gnu` |
| Linux x64, musl (Alpine) | `@e2e-dev/util-linux-x64-musl` |
| Linux arm64, musl (Alpine) | `@e2e-dev/util-linux-arm64-musl` |
| Windows x64 | `@e2e-dev/util-win32-x64-msvc` |
| Windows arm64 | `@e2e-dev/util-win32-arm64-msvc` |

On any other platform the first call throws `NativeUtilUnavailableError`,
naming these.

## Development

```bash
pnpm --filter @e2e-dev/util build:native   # cargo build --release, places util.<platform>.node here
pnpm --filter @e2e-dev/util build          # the TypeScript
pnpm --filter @e2e-dev/util test           # the addon against the JavaScript it replaced, byte for byte
pnpm --filter @e2e-dev/util bench          # the addon against that JavaScript: time, event-loop stalls, memory
pnpm --filter @e2e-dev/util licenses:native   # the crates' notices in each platform package, after a dependency change
cargo test -p e2e-util                     # the crate alone
```

A release builds the eight addons in `.github/workflows/util-native.yml`
and puts them in the platform packages (`packages/util/npm/<platform>`)
before it publishes.

The tests and the benchmark render browser screenshots with Chromium on
first use and keep them in `.cache/`.

## License

Apache-2.0
