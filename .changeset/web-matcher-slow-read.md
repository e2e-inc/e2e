---
"@e2e-dev/web": patch
---

`expect(browser).toHaveClass` and `toHaveTitle` now fail a value that never matches with `ASSERTION_FAILED` on a busy page, not with `ACTION_FAILED` when the deadline cuts off the last read. `toHaveClass` also now refuses a target that is not an e2e locator from the current attempt with `INVALID_LOCATOR`.
