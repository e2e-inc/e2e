---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
'@e2e-dev/web': patch
---

Accept `app.permissions: 'all'` to grant every permission the target's engine can grant. A `mobile()` target sends one `permission all grant` before each fresh launch, which covers every permission an Android app declares and `simctl privacy grant all` on an iOS simulator; `device.openApp(app, { permissions: 'all' })` does the same for one launch. A `web()` target grants each permission its browser grants. A map of names still works, and nothing is granted unless the target asks.
