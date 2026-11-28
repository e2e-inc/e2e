---
'@e2e-dev/electron': patch
---

On Windows and Linux, screenshots and video of a window the app showed and then hid with `hide()` work. A screenshot used to wait out the whole timeout, and a recording wrote no video. The engine now starts every window with `backgroundThrottling` off.
