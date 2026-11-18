---
"@e2e-dev/mobile": patch
---

Add `device.isKeyboardShown()`, which returns whether the soft keyboard is on screen. It answers from what agent-device reports for the keyboard, else from keyboard elements drawn on screen in the accessibility tree, the same keyboard observations hide covered nodes under. It answers `false` only when agent-device proves there is no keyboard; otherwise it fails with the reason. It changes nothing on the device. `device.dismissKeyboard()` now uses the same rule to decide whether the keyboard is up, so a probe that says the keyboard is hidden wins over keys the tree still lists.
