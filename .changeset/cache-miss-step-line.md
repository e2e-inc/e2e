---
'@e2e-dev/core': patch
'e2e': patch
---

The terminal names a cache miss that returns on every run until you act: an `agent.act` step whose recording is `truncated`, `invalid-entry`, or `wrong-context` ends its line with `not replayed: <reason>`. A step's `end` progress carries `cache` (`mode` and `reason`) for custom reporters.
