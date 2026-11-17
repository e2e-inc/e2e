---
'@e2e-dev/core': patch
---

An engine server started with `spawnTransport` that exits during a request now always shows its exit code and last stderr lines in the failure, not only on some runs.
