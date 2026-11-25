---
'@e2e-dev/core': patch
'e2e': patch
---

A test body or `afterAll` hook that kept running past its timeout can no longer act on the next test's page. Its engine calls are cancelled, also when a fixture teardown or a later hook ran in between.
