---
'@e2e-dev/revyl': patch
---

`revyl()` records video: an attempt that records one, such as with `--video`, gets Revyl's own screen recording of the device as `video/recording.mp4` instead of failing with `UNSUPPORTED_CAPABILITY`. Revyl stops a recording at 3 minutes, or sooner at its size cap. A `device` or `osVersion` Revyl does not list for the platform now fails the lease before a device starts, naming the ones Revyl has, instead of a bare 422 from Revyl.
