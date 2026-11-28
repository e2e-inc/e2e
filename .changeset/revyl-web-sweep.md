---
'@e2e-dev/revyl': patch
---

`revylBrowsers()` now stops, when the run ends, the Revyl session of any worker that died before it could stop it, instead of leaving it open until `idleTimeoutSeconds` runs out. The default session size is documented as 1280 by 800.
