---
'@e2e-dev/electron': patch
---

On Windows, screenshots and video of a window the app showed and then hid with `hide()` work. A screenshot used to wait out the whole timeout and a recording wrote no video, because Windows draws nothing of a hidden window while its renderer is throttled in the background.
