---
'e2e': minor
'@e2e-dev/core': minor
---

**Breaking:** `test.fixme` skips a test at registration or from inside its body and adds a new `skip.cause` value, `fixme`, to `report-1` reports. Update validators to the new `report-v1.schema.json` and handle `fixme` in any exhaustive skip-cause checks.
