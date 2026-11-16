---
"e2e": patch
"@e2e-dev/core": patch
"@e2e-dev/web": patch
---

Run page code on the one element a locator matches with `browser.evaluateOn(locator, fn, arg)`, and wait for its computed style or a DOM property with `expect(browser).toHaveCSS(locator, 'position', 'sticky')` and `expect(browser).toHaveJSProperty(locator, 'offsetWidth', 240)`, and `expect(browser).toHaveClass` now refuses a target that is not a locator with `INVALID_LOCATOR` instead of a `TypeError`.
