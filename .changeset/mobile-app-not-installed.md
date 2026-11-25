---
'@e2e-dev/mobile': patch
---

Fail `app.open()`, `device.openApp()`, and `device.openLink()` of an app the device does not have as `TEST_SETUP_FAILED`, with a message that names the app and how to install it. Before, iOS reported it as `ENGINE_FAILURE` (exit 3) with agent-device's CLI advice, and the agent's `open_app` tool could not tell a wrong app name from a device fault there.
