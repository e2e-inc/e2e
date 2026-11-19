---
'e2e': patch
---

`test.skip(condition, reason)` and `test.fail(condition, reason)` no longer skip or mark a test when the condition is `undefined`, `0`, or another falsy value, and a condition missing its `await` now fails the test instead of skipping or marking it every time.
