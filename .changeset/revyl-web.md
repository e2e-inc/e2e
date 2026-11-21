---
'@e2e-dev/revyl': patch
---

Adds `revylWeb()` from `@e2e-dev/revyl/web`, an engine that runs web tests in Chrome on Revyl through Revyl's API. The package now builds on `@e2e-dev/core` like the engines: it peers on `@e2e-dev/core`, and `e2e` and `@e2e-dev/mobile` are optional peers (`revyl()` needs `@e2e-dev/mobile`).
