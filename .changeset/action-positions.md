---
'@e2e-dev/core': patch
'e2e': patch
---

`doubleTap`, `dblclick`, `secondaryTap`, and `hover` take `position`, as `tap` and `click` do, like Playwright's `dblclick({ position })` and `hover({ position })`. A `position` coordinate can now be a percentage of the node's box: `{ x: '50%', y: '50%' }` is its center, and `'100%'` stays on its last pixel. Pixels are still measured from the node's top-left corner. `hover({ position })` needs the engine's `hover` pointer action, so it fails with `UNSUPPORTED_CAPABILITY` on a device.
