---
"@e2e-dev/web": patch
---

A `browser.evaluate` string that names `arg` without declaring it now reads the page's global `arg`: write `'(arg) => arg + 1'` to read the argument.
