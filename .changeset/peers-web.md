---
"@e2e-dev/web": patch
---

A run that puts a test's peer on a target with a browser provider, or on a browser attached over CDP (`web({ connect })`), fails before any test with `UNSUPPORTED_CAPABILITY`, before anything is leased. A peer on a target that launches its own browser runs as usual.
