---
'@e2e-dev/core': patch
---

Cached coordinate drags wait for the drop target when the recorded point identifies the source among same-named controls. During that wait, replay stops if the matching group of visible, placeable controls shrinks, even when the original source stays in place. A source or drop target recovered during the wait must have a visible, usable box.
