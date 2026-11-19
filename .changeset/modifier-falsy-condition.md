---
'e2e': patch
---

`test.skip(condition, reason)` and `test.fail(condition, reason)` inside a test body now read the condition by truthiness, as Playwright does. A falsy condition such as `undefined`, `0`, or `''` no longer skips or marks the test, and the reason is always the second argument. The one-argument forms are unchanged: `test.skip()`, `test.skip('reason')`, and `test.skip(undefined)` still skip.
