---
'@e2e-dev/core': patch
---

`agent.assert`, `agent.waitFor` and `agent.extract` check their instruction the way `agent.act` does: one that is not a string, is empty or only whitespace, or is over 8192 UTF-8 bytes after NFC normalization is `INVALID_ARGUMENT` before any model call.
