---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
---

On the web, `dragTo` accepts `{ sourcePosition, targetPosition, steps }` like Playwright's `dragTo`: where to press on the source, where to release on the target, in pixels from each node's top-left corner inside its border, and how many pointer moves the drag takes. Engines declare `dragOptions: true` to receive them; on any other engine they fail with `UNSUPPORTED_CAPABILITY` before either node is looked up. The browser engine takes at most 1000 steps.

The web engine now needs `@e2e-dev/core` and `e2e` 0.25.1 or later, since it declares `tapButtons` and `dragOptions`, which older releases refuse as unknown engine keys.
