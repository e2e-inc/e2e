---
'@e2e-dev/core': patch
'e2e': patch
---

A test whose timeout runs out during a locator wait now ends `timed-out`, with the call recorded as `cancelled`. A wait the test's remaining time capped, such as a `waitFor` with a longer timeout of its own, could instead fail the test with its own error (`LOCATOR_NOT_FOUND`) when Node ran its timer before the test's, or when the engine cut its last read short of the deadline.
