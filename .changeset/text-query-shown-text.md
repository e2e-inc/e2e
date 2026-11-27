---
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
'e2e': patch
---

`getByText` on a device or a desktop app matches the text a node shows, and its accessible name only when it has no text of its own. A value named by a label beside it (a `5` named `Words`) no longer makes `getByText('Words')` ambiguous. A node that shows text under another accessible name, such as an Android text with a content description, no longer answers `getByText` by that name: find it by its text, or with `getByLabel`. On the desktop engine a web view's heading reads its text, not its level.
