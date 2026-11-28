---
'@e2e-dev/core': patch
---

The `test.step()` docs now explain that in a `beforeAll` or `afterAll` hook, a worker fixture, or an `openHost()` session, the body runs but no report includes the step, and that a call from work its phase left running is `CANCELLED`.
