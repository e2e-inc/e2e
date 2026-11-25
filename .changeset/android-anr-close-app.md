---
'@e2e-dev/mobile': patch
---

A tap on the "Close app" button of an Android "isn't responding" dialog now closes the dialog, also when System UI is the app that hangs. agent-device refuses every input while that dialog has focus, the dialog's own buttons included, so the tap goes through `alert dismiss`, which it does not refuse. Any other input refused this way before it was sent, a node action or `device.back`, `home`, `pressRemote`, `shake`, `dismissKeyboard`, `setOrientation`, or `fold`, is now `NOT_ACTIONABLE` (`ACTION_FAILED` in a test), not `ENGINE_FAILURE`, and the agent sees it as `ACTION_FAILED`, not `APP_UNREACHABLE`. Its hint says to tap "Close app" or call `device.alert('dismiss')`. agent-device's own hint said to wait or reboot the emulator, and neither closes the dialog.
