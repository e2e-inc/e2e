---
"@e2e-dev/web": patch
---

`getByText` now matches text a line break separates as it reads: `getByText('Line one line two')` finds `<p>Line one<br>line two</p>`, the text `textContent()` returns for it. Before, only `'Line oneline two'` matched.
