---
'@e2e-dev/core': patch
---

A locator that fails because the engine's read went stale or ran out of time now ends with the engine's reason, as in `node became stale: getByRole("button") (the window was read only in part ...)`, where it said only `node became stale` or `operation timed out`.
