---
'@e2e-dev/desktop': patch
---

`app.open()` launches the app with `-NSDocumentSaveNewDocumentsToCloud NO`, so a document-based app with iCloud Documents no longer autosaves each run's untitled document into iCloud Drive. The target's `app.launchArguments` still win: `{ NSDocumentSaveNewDocumentsToCloud: true }` turns it back on. [Write a test](https://e2e.com/docs/desktop#write-a-test)
