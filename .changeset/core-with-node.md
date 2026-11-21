---
"@e2e-dev/core": patch
---

Let an engine fixture run code on the one node a test's locator matches with `context.withNode`, and compare text without collapsing whitespace with the `compareText` export, and refuse a read on a secure field with the runner's own message through `secureReadDenied`.
