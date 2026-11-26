---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
---

On the web, `dragTo` accepts `{ sourcePosition, targetPosition, steps }` like Playwright's `dragTo`: where to press on the source, where to release on the target, in pixels from each node's top-left corner inside its border, and how many pointer moves the drag takes. Engines declare `dragOptions: true` to receive them; on any other engine they fail with `UNSUPPORTED_CAPABILITY` before either node is looked up.

On the web, a drag of a `getByLabel` or `getByDisplayValue` match or of an observed node fails with `ACTION_FAILED` before the button goes down when a position is outside its node's box, or when the point is outside the viewport after the target node is scrolled into view. When the step times out during the moves, it releases the button, and a failure after the press is never repeated.
