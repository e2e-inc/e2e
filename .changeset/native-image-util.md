---
'@e2e-dev/util': patch
'@e2e-dev/util-darwin-arm64': patch
'@e2e-dev/util-darwin-x64': patch
'@e2e-dev/util-linux-arm64-gnu': patch
'@e2e-dev/util-linux-arm64-musl': patch
'@e2e-dev/util-linux-x64-gnu': patch
'@e2e-dev/util-linux-x64-musl': patch
'@e2e-dev/util-win32-arm64-msvc': patch
'@e2e-dev/util-win32-x64-msvc': patch
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/mobile': patch
---

Screenshot pixel work (PNG decoding and encoding, resizing for the model, `toHaveScreenshot` captures and comparisons, `locator.screenshot()` crops, and mobile masking) now runs in the new `@e2e-dev/util` native addon, off the JavaScript thread. npm installs its build for your platform with it, from `@e2e-dev/util-<platform>`: macOS on arm64 and x64, Linux on x64 and arm64 with glibc 2.35 or later or with musl, and Windows on x64 and arm64. On any other platform, a run that reads or writes a screenshot fails with `IMAGE_CODEC_UNAVAILABLE`, naming the platforms there are. The output is byte for byte what `@napi-rs/image` and `pixelmatch` produced, so stored screenshots do not change. `@napi-rs/image` and `pixelmatch` are no longer dependencies.
