---
"@e2e-dev/mobile": patch
---

Add `device.isKeyboardShown()`, which returns whether the soft keyboard is on screen. It answers from what agent-device reports for the keyboard, else from the keyboard elements in the accessibility tree, the same keyboard observations hide covered nodes under, and changes nothing on the device.
