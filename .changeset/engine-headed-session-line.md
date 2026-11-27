---
'@e2e-dev/core': patch
'@e2e-dev/desktop': patch
'e2e': patch
---

Fix `open_session` reporting `headless` for a desktop target with `desktop({ headed: true })`. An engine can now declare `alwaysHeaded: true` when an option of its own shows its surface without `--headed`, and the session line says `headed` for it. `@e2e-dev/desktop` declares it, so it now needs `@e2e-dev/core` and `e2e` 0.25.1 or newer.
