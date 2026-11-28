---
'e2e': patch
---

`e2e init` has a desktop engine for native macOS apps: `npx e2e init --engine desktop`, or pick it at the prompt. It writes a target with `engine: desktop()` and `app: { bundleId: 'com.apple.calculator' }`, an example test that opens Calculator, and the `@e2e-dev/desktop` dependency. The CI pipeline that init writes has no job for the macOS target, which needs a Mac runner whose CI agent has the Accessibility permission. [Desktop](https://e2e.com/docs/desktop)
