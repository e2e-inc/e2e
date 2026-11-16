---
"e2e": patch
"@e2e-dev/core": patch
"@e2e-dev/web": patch
---

Run page code on the one element a locator matches with
`browser.evaluateOn(locator, (el, arg) => ..., arg)`, and wait for a computed
style or a DOM property with `expect(browser).toHaveCSS(locator, 'position',
'sticky')` and `expect(browser).toHaveJSProperty(locator, 'offsetWidth', 240)`.
The locator keeps its scope, frame, and exactly-one rule, unlike a
`document.querySelector` inside `browser.evaluate`. Engines reach the node a
test's locator matches from a fixture with the new
`EngineFixtureContext.withNode(locator, use)`.
