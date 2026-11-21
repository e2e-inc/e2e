---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

Add `count` to `locator.tap()` and `click()`: `tap({ count: 3 })` taps three times in a row, which the platform reads as one triple click. `count: 2` is the same action as `doubleTap()`. Three or more go through the new `multiTap` engine action, which the browser and mobile engines declare; an engine without it fails with `UNSUPPORTED_CAPABILITY`.
