---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
---

On the web, `dragTo` accepts `{ sourcePosition, targetPosition, steps }` like Playwright's `dragTo`: where to press on the source, where to release on the target, in pixels from each node's top-left corner inside its border, and how many pointer moves the drag takes. Engines declare `dragOptions: true` to receive them; on any other engine they fail with `UNSUPPORTED_CAPABILITY` before either node is looked up.

On the web, a drag of a `getByLabel` or `getByDisplayValue` match or of an observed node now scrolls the release point into view, and fails with `ACTION_FAILED` instead of dropping on whatever is there when that point is outside the target or covered.
