---
'e2e': patch
'@e2e-dev/core': patch
---

`test.skip(condition, reason)`, and the same form of `test.fixme`, `test.fail`, and `test.slow`, now do nothing when the condition is falsy (such as an unset `process.env.CI`), take the reason from the second argument (`test.slow` reports none), and fail with `INVALID_ARGUMENT` when the condition is a Promise or a function. A lone `test.skip(0)` or `test.skip(null)` no longer skips either.
