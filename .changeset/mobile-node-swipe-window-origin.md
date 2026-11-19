---
'@e2e-dev/mobile': patch
---

An iOS swipe on a node, and a `scrollUntilVisible` scoped to a locator, now fails as `ACTION_FAILED` (`NOT_ACTIONABLE`) when agent-device's snapshot warns that it cannot establish the window origin on screen. Nothing is sent. Before, the swipe went out at points taken from bounds that may be offset from screen coordinates by the window's position. The message names `screen.swipe({ direction })` and `screen.swipe({ from, to })` with points not taken from those bounds.
