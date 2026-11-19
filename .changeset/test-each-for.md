---
'e2e': patch
'@e2e-dev/core': patch
---

Add `test.each(rows)` and `test.for(rows)`, which register one test per row with a title formatted from the row (`$user`, `%s`, `%i`, `%#`). `test.each` spreads an array row into the body's arguments and `test.for` passes it whole. The fixtures come last, and the body names the ones it uses by destructuring that parameter: `async ({ user }, { app }) => {}`.
