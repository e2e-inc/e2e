---
'@e2e-dev/core': patch
---

Cached coordinate drags wait for the drop target when the recorded point identifies the source among same-named controls. Replay stops if one of those controls disappears or becomes hidden during the wait.
