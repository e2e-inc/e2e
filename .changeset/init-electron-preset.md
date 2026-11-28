---
'e2e': patch
---

`e2e init` has an Electron engine: `npx e2e init --engine electron`, or pick it at the prompt. It writes a target with `engine: electron()` and `app: { appPath: '.' }`, an example test, and the `@e2e-dev/electron` dependency. A CI pipeline init writes leaves the Electron target out, since it needs a display; run it under `xvfb-run` on Linux. [Electron](https://e2e.com/docs/electron#run-in-ci-on-linux)
