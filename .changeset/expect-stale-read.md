---
'e2e': patch
'@e2e-dev/core': patch
---

An `expect` poll, `locator.waitFor`, and the other polling reads no longer fail with `node became stale` when the engine found the screen changing under every read until the deadline, as a SwiftUI app that re-creates its elements on each state change can make it. They sample again, and a timeout is the assertion's own `ASSERTION_FAILED` (or `waitFor`'s `LOCATOR_NOT_FOUND`), whose `observed` line gives the engine's own reason the last reads failed, such as a locked screen, and carries that error as its cause. Such a read never lets a negated assertion or `waitFor({ state: 'detached' })` pass.
