---
"@e2e-dev/core": patch
"e2e": patch
---

A `secrets`, `credentials`, or `services` entry may be `undefined`. So `defineConfig` keeps the config's inferred type when one of them is written as `ci ? { … } : {}` in a project without `exactOptionalPropertyTypes`. Before, the config fell back to `E2EConfig`, and `test.extend` rejected `typeof config` with an error that blamed a type annotation. A service set to `undefined` starts nothing. A secret set to `undefined` takes its value from `E2E_SECRET_<NAME>`, as before. A credential set to `undefined` now takes its username and password from `E2E_USER_<NAME>_USERNAME` and `E2E_USER_<NAME>_PASSWORD`, where before it was `INVALID_CONFIG`.
