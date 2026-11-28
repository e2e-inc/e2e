---
'e2e': patch
---

With the `list` or `line` reporter writing to a pipe or a file, as in CI, a run that prints a lot (`NODE_DEBUG=*`, a test that logs heavily) no longer runs about three times slower than its tests.
