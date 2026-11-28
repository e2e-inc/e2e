---
'@e2e-dev/core': minor
'e2e': minor
'@e2e-dev/mobile': minor
'@e2e-dev/desktop': minor
'@e2e-dev/web': patch
'@e2e-dev/electron': patch
---

**Breaking:** `getByText` on a device or a desktop app no longer matches a node by its accessible name when the node shows text of its own. It matches the text the node shows, and the name only of a node that shows none, such as an icon button. Replace `getByText(name)` with `getByLabel(name)`, or query the text the node shows. This affects a text an app names otherwise, an Android text or filled field with a content description (`<Text accessibilityLabel="Total price">$5</Text>` answers `getByText('$5')` and `getByLabel('Total price')`), and an empty Android field with a description, which `getByText` finds by its hint. A value named by the label beside it (a `5` named `Words`) no longer makes `getByText('Words')` ambiguous. `filter({ hasText })` still reads names, text, and values. `resolveExpression` from `@e2e-dev/core/engine` follows the same rule, and `shownText(node)` is exported beside it for an engine that matches text itself. On the desktop engine a row or a cell reads the text inside it as its text, without the text scrolled out of it while the row itself is on screen, and a web view's heading reads its title as its text and its level from the number it reports as its value. `@e2e-dev/mobile` and `@e2e-dev/desktop` now need `@e2e-dev/core` and `e2e` 0.26.0 or newer. The web and Electron engines are released with it and read text as before.
