---
'@e2e-dev/revyl': patch
---

`revyl()` records video: an attempt that records one, such as with `--video`, gets Revyl's own screen recording of the device as `video/recording.mp4` instead of failing with `UNSUPPORTED_CAPABILITY`. Revyl stops a recording at 3 minutes, or sooner at its size cap. A stop cut off by a dropped connection, a gateway error, or a broken download is sent again, and Revyl answers it with the same video; the download gets 5 minutes. A recording Revyl discarded, such as an empty one, leaves that attempt without a video, and the next attempt records again. When Revyl refuses to start a `device` or `osVersion` its device catalog does not list for the platform, the error now names the ones Revyl has instead of being a bare 422.
