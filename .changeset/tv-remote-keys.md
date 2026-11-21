---
'@e2e-dev/mobile': patch
---

The mobile engine declares `remoteKeys` and presses TV remote keys through agent-device's `tv-remote`, and `device.pressRemote(key)` presses one with no node to address. A device without the button rejects with `UNSUPPORTED_CAPABILITY`, and a name outside the list is `INVALID_ARGUMENT`. A refused keyboard key names the remote key to press instead. It needs `@e2e-dev/core` and `e2e` 0.25.0 or later, the first releases whose key grammar has the remote keys.
