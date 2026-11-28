---
"@e2e-dev/mobile": patch
---

Check in `e2e doctor` that an iOS `app.appPath` bundle is a simulator build matching `app.bundleId`. tvOS and visionOS simulator builds count, and a device build's message names the simulator SDK to build with. Whether the target drives simulators comes from agent-device's device inventory.
