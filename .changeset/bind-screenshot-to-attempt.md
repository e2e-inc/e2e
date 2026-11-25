---
'@e2e-dev/core': patch
---

A screenshot that an engine server returns as bytes after its attempt ended is no longer written into the next attempt's artifact directory. The call fails with `INVALID_STATE` instead.
