---
'@e2e-dev/core': patch
---

A negated assertion such as `expect(locator).not.toBeVisible()` no longer passes when the timer before its last check fires late. The time the negation held is counted only up to the timeout, so the same run passes or fails the same way on a busy machine.
