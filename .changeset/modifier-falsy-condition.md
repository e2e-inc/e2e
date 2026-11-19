---
'e2e': patch
---

`test.skip(condition, reason)` and `test.fail(condition, reason)` no longer skip or mark a test when the condition is `undefined`, `0`, or another falsy value, and inside a test body a condition missing its `await` now fails that test with `INVALID_ARGUMENT` instead of always skipping or marking it.
