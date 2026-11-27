---
'@e2e-dev/electron': patch
---

On Windows, `app.screenshot()` and the agent's screenshots of a window the app showed and then hid with `hide()` return at once. They used to wait out the whole timeout, because Windows draws nothing of a hidden window while its renderer is throttled in the background.
