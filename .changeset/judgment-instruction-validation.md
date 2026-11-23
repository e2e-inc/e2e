---
'@e2e-dev/core': patch
---

`agent.assert`, `agent.waitFor` and `agent.extract` check their instruction the way `agent.act` does. One that is not a string, is empty or only whitespace, or is over 8192 UTF-8 bytes after NFC normalization is `INVALID_ARGUMENT` before any model call. Before, `agent.assert('')` (say from an unset env var) went to the judge, which could pass it, `undefined` failed with a bare `TypeError`, and an oversized one was sent as is. The judge now reads the NFC form, as `act` does.
