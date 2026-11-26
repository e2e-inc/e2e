---
'@e2e-dev/mobile': patch
---

`device.addMedia(paths)` adds photos and videos to the device's library for a test of the system photo picker: `xcrun simctl addmedia` on an iOS simulator, `adb push` and a media scan on an Android emulator or phone. A physical iPhone, a device a provider leased, and a device behind a remote agent-device daemon fail with `UNSUPPORTED_CAPABILITY`.
