---
'@e2e-dev/core': patch
---

Cached coordinate drags wait for the drop target when the recorded point identifies the source among same-named controls. Replay stops if fewer visible, placeable controls match the initial source identity during the wait or a recovered endpoint has no visible, usable box.
