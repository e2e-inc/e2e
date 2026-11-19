---
"@e2e-dev/core": patch
---

An engine matcher built on `pollCondition` can fail a slow read the deadline cuts off as an assertion, not a timeout, by running its reads through the `reads.read` that `evaluate` now receives.
