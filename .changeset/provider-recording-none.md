---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
---

A provider recording's `stop` can return `{ none: reason }` when its service ended the recording without a video, such as one it discarded. The engine lets go of that recording, so the worker's next attempt starts and records again instead of failing on the same stop. The stop fails with `ENGINE_FAILURE` naming the reason, which a required video reports as a cleanup failure. A stop that throws still leaves the recording to be stopped again. [Provider recordings](https://e2e.com/docs/reference/engine#provider-recordings)
