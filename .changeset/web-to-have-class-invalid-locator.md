---
"@e2e-dev/web": patch
---

`expect(browser).toHaveClass` now refuses a target that is not an e2e locator from the current attempt with `INVALID_LOCATOR`.
