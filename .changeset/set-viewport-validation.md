---
'@e2e-dev/web': patch
---

`browser.setViewport` refuses a size that is not `{ width, height }` in whole, non-negative pixels, or that has another key, with `INVALID_ARGUMENT` before the engine is asked. `web({ viewport })` and `web({ screencast: { size } })` check the same shape with each side at least 1, so `0x0` stays refused there, and their errors now name the side that is wrong and suggest the key a misspelled one meant.
