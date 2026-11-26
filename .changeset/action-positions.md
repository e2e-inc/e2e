---
'@e2e-dev/core': patch
'e2e': patch
---

`doubleTap`, `dblclick`, `secondaryTap`, and `hover` take `position`, as `tap` and `click` do, like Playwright's `dblclick({ position })` and `hover({ position })`. A `position` coordinate can now be a percentage of the node's box, as `boundingBox()` reports it, cut to the viewport: `{ x: '50%', y: '50%' }` is the center of the part in view, and `'100%'` its last pixel. A scroll container, an `overflow: hidden` ancestor, and an outer frame that a nested frame's content overflows don't cut the box, so on a node one of them cuts, use a pixel position or scroll first. A CSS transform on a frame isn't counted either, so no position lands where a scaled frame draws the node. Pixels are still measured from the node's top-left corner. `hover({ position })` needs the engine's `hover` pointer action, so it fails with `UNSUPPORTED_CAPABILITY` on a device.
