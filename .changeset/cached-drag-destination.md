---
'@e2e-dev/core': patch
---

Cached coordinate drags wait for a drop target that is late or still hidden, including when the recorded point picks the source out of same-named controls. Replay stops if one of those controls disappears meanwhile. A cached tap, hover, or drag at a recorded point is placed only in a visible control: one that is listed but hidden is waited for instead of acted on.
