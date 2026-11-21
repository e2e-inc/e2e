---
'@e2e-dev/mobile': patch
---

`check()` and `uncheck()` on a device read the control again after the tap and fail with `ACTION_FAILED` when its checked state does not change before the timeout, as on the web. `uncheck()` on a checked radio is refused instead of tapping it and passing.
