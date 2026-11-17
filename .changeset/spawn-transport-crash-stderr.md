---
'@e2e-dev/core': patch
---

An engine server started with `spawnTransport` that exits during a request now fails it with the server's exit code or signal and its last stderr lines.
