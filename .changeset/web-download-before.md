---
'@e2e-dev/web': patch
---

Browser providers get an optional `downloads.before` hook. It runs once per `waitForDownload` or `waitForDownloads`, before the trigger, and its result reaches each `read` of that wait as `context.before`, so a service that stores downloads by name can tell a new file from an older one with the same name.
