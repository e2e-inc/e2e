---
'@e2e-dev/mobile': patch
---

Fail `app.open()`, `app.restart()`, `app.clearState()`, `device.openApp()`, and `device.openLink()` of an app the device does not have as `TEST_SETUP_FAILED`, with a message that names the app and how to install it. Before, agent-device's CLI advice (`Run install before open`) reached the test. An iOS simulator launch of a missing bundle is still `ENGINE_FAILURE`: agent-device reports it as `COMMAND_FAILED`.
