---
'e2e': patch
'@e2e-dev/core': patch
---

Add `test.fixme`, which skips a test at registration or from inside its body and reports it with the reason `fixme`, or `fixme: <reason>` when you give one.
`test.skip(title, fn)` inside a serial group now fails with an error that names `test.skip()`, as `test.fixme`, `test.skipIf`, and `test.runIf` do.
