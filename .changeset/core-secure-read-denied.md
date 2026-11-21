---
"@e2e-dev/core": patch
---

Export `secureReadDenied(subject)` from `@e2e-dev/core/engine`, the `POLICY_DENIED` error for a read on a secure field, so an engine refuses with the same message as the runner.
