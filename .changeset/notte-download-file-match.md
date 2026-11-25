---
'@e2e-dev/notte': patch
---

`browser.waitForDownload()` on Notte no longer returns an older file of the same name that was already in the session's file storage when the wait began, such as a download the app started with no wait.
