---
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
'e2e': patch
---

`getByText` on a device or a desktop app matches the text a node shows, and its accessible name only when it shows none. A value named by a label beside it (a `5` named `Words`) no longer makes `getByText('Words')` ambiguous: find it with `getByText('5')` or `getByLabel('Words')`.
