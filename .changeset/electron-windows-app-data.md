---
'@e2e-dev/electron': patch
---

On Windows, a test no longer ends with `cleanup failed: ... EPERM` when the app's processes still hold files in its data directory after it quit. The directory is deleted with a later test's, or when the worker ends. `app.clearState()` starts the app on a new, empty data directory instead of emptying the old one.
