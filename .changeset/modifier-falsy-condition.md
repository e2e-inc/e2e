---
'e2e': patch
---

Inside a test body, `test.skip` and `test.fail` no longer skip or mark the test for a falsy condition such as `0`, `null`, or `undefined` with a reason, and a Promise or a function as the condition now fails the test with `INVALID_ARGUMENT` instead of always applying.
