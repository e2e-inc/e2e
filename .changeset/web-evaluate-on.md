---
"e2e": patch
"@e2e-dev/core": patch
"@e2e-dev/web": patch
---

Add `browser.evaluateOn(locator, fn, arg)`, which runs page code on the one element a locator matches, and the `expect(browser).toHaveCSS` and `toHaveJSProperty` matchers, which wait for that element's computed style or DOM property.
