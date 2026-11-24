---
'@e2e-dev/eas': patch
---

`expoSimulators()` installs a local build itself: with no `buildId` or `applicationArchiveUrl`, the target's `app.appPath` is uploaded to each simulator and installed there, so the suite needs no `device.installApp()` fixture. A session whose build does not install is stopped. Needs `@e2e-dev/mobile` 0.12.9 or later.
