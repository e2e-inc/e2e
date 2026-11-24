---
'@e2e-dev/core': patch
---

`agent.assert`, `agent.waitFor` and `agent.extract` check their instruction the way `agent.act` does: one that is not a string, is empty or only whitespace, or is over 8192 UTF-8 bytes after NFC normalization is `INVALID_ARGUMENT` before any model call. `agent.act` and these three now redact registered secrets, provider keys included, from the instruction as written before it is normalized, so a secret followed by a combining character stays out of the model input and the report.
