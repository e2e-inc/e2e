---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
---

`modifiers` work with `position` on `tap`, `click`, `doubleTap`, `dblclick`, and `secondaryTap`, and `hover` takes `modifiers`, like Playwright's `click({ position, modifiers })` and `hover({ position, modifiers })`. On the web, exactly the named keys are held: a key the test holds with `browser.keyboard.down` is released for the action and pressed again after it, as in Playwright. Engines declare the new `pointerModifiers: true` capability to receive `modifiers` on the `tap`, `doubleTap`, `multiTap`, `secondaryTap`, and `hover` pointer actions and on the `hover` node action. Without it, such an action fails with `UNSUPPORTED_CAPABILITY` before the node is looked up. The web engine declares it, the mobile and desktop engines don't. The web engine needs `@e2e-dev/core` and `e2e` 0.25.1 or later, since it declares `pointerModifiers`.
