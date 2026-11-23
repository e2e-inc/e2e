---
'@e2e-dev/core': patch
---

`projectId` must be a string: a number, boolean, `null`, object or array is `INVALID_CONFIG` when the config loads, as every other wrong-typed option is.
