---
'@e2e-dev/mobile': patch
---

An iOS action on a node that agent-device refuses with `window-origin-unknown` now fails as `ACTION_FAILED` (`NOT_ACTIONABLE`) instead of an infrastructure `ENGINE_FAILURE`. agent-device sent nothing, and for a tap the message names `screen.tapAt()`, which agent-device still takes.
