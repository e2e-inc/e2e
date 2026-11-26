---
'@e2e-dev/electron': patch
---

New package: `@e2e-dev/electron`, the Electron engine. `engine: electron()` launches an Electron app (the project's `electron` package running `app.appPath`, or a packaged app through `executablePath`) on an empty user-data directory per attempt, and reads its windows through Chromium's accessibility tree over the DevTools protocol: observation, the `screen` locators and actions, test ids, masked screenshots, the app's windows as tabs, and the `electron` fixture with `evaluate` in the main process, `windows`, `useWindow`, and `locator`. It uses only the public engine contract and has no runtime dependency: it starts the app and speaks the DevTools protocol itself, the windows over a pipe that opens no port. A window that has loaded no page does not hold up the launch, and a packaged app built with the `EnableNodeCliInspectArguments` fuse off launches too, without `electron.evaluate`.
