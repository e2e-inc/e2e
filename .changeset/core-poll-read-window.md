---
"@e2e-dev/core": patch
---

`pollCondition`'s `evaluate` now receives `reads`, so an engine matcher that runs each read through `reads.read` fails a value that never matches on a slow page as an assertion, not a timeout.
