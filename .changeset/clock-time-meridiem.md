---
'@e2e-dev/core': patch
---

A recorded step that showed a clock time with am or pm written against it (`Last saved 5:42pm`) now replays a minute later. The time was read as fixed text and kept as an end anchor, while `5:42 PM` and `17:42` were already skipped.
