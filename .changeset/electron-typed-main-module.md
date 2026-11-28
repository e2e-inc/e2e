---
'@e2e-dev/electron': patch
---

`electron.evaluate` types the `electron` module its function receives with the project's own `electron` package, a required peer, in place of `any`.
