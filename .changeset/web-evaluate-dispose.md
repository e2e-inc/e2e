---
"@e2e-dev/web": patch
---

A long `expect.poll` over `browser.evaluate` no longer grows the runner's memory with every read until the page closes.
