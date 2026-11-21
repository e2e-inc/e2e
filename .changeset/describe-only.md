---
"e2e": patch
---

Add `test.describe.only(title, fn)` and the `only` option on `describe`, which focus every test in the group the way `test.only` focuses one. CI rejects a focused group with `ONLY_IN_CI`.
