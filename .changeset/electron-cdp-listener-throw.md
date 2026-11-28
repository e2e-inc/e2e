---
'@e2e-dev/electron': patch
---

A DevTools event listener that throws no longer drops the other messages that arrived with its event. The commands those messages answered would have waited out their whole budget and failed with a timeout. The listener's error is still reported.
