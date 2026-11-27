---
'@e2e-dev/desktop': patch
---

`app.open()` launches an app that can keep documents in iCloud with `-NSDocumentSaveNewDocumentsToCloud NO`, so it no longer autosaves each run's untitled document into iCloud Drive. Other apps do not get the argument. The target's `app.launchArguments` still win: `{ NSDocumentSaveNewDocumentsToCloud: true }` turns it back on. [Write a test](https://e2e.com/docs/desktop#write-a-test)
