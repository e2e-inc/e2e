---
"@e2e-dev/web": patch
---

A long `expect.poll` over `browser.evaluate` no longer keeps one Playwright object per read until the page closes.
