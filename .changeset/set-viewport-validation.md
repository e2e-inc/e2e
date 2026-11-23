---
'@e2e-dev/web': patch
---

`browser.setViewport` refuses a size that is not `{ width, height }` in whole, non-negative pixels, or that has another key, with `INVALID_ARGUMENT` before the engine is asked. Before, a fractional or negative side, a missing `height` (reported as `800xundefined`) or a call with no size was an `ENGINE_FAILURE` with exit code 3, as if the browser had broken, and an extra key such as `deviceScaleFactor` was ignored.
