---
"@e2e-dev/web": patch
---

`browser.evaluate` now returns a plain object made in a same-origin iframe, such as `iframe.contentWindow.eval('({ a: 1 })')`, instead of failing with `evaluate result must be JSON-safe`.
