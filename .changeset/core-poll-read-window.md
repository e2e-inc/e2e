---
"@e2e-dev/core": patch
---

Hand `pollCondition`'s `evaluate` the poll's `ReadWindow`, so an engine matcher that runs its reads through it fails a slow read cut off at the deadline as an assertion, not a timeout.
