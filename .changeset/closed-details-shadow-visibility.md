---
"@e2e-dev/web": patch
---

`toBeVisible()` and `isVisible()` now read an element as hidden when a closed `<details>` folds it away across a shadow boundary: an element in a shadow tree under a closed `<details>`, and an element slotted into a closed `<details>` inside an open shadow root or a closed one created with `attachShadow()`. Before, `toBeVisible()` passed on such an element although the page did not show it, and the agent's tree listed the slotted ones. A `display: contents` element whose own text is its content still reads visible there, as Playwright reads it. An element slotted into a closed shadow root created with `attachShadow()` under `content-visibility: hidden` now reads hidden as well, as it already did for an open root.
