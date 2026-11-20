---
'e2e': minor
'@e2e-dev/core': minor
---

**Breaking:** `expect.poll` no longer takes `interval`. Pass `intervals`, a list of pauses whose last entry repeats. The default pauses are now `[100, 250, 500, 1000]` ms instead of a flat 100 ms.

Added `expect(fn).toPass()` for retrying a block of assertions, with `.not` and `expect.soft` forms. Defaults for `toPass` can be set with `toPass` in the config.
