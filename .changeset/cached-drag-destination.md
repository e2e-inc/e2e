---
'@e2e-dev/core': patch
---

Cached coordinate drags wait for the drop target when the recorded point identifies the source among same-named controls. Replay stops if fewer visible, placeable source candidates remain during the wait or the recovered source has no visible, usable box.
