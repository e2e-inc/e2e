---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
'@e2e-dev/web': patch
---

Accept `app.permissions: 'all'` to grant every permission the target's engine can grant. A `mobile()` target grants them before each fresh launch: on Android every permission the app declares, in one agent-device `all` grant; on an iOS simulator every permission but `notifications`, which the simulator refuses to set, one by one, since it ignores the `all` service `simctl privacy grant all` records. `device.openApp(app, { permissions: 'all' })` does the same for one launch. A `web()` target grants each permission its browser grants. A map of names still works, and nothing is granted unless the target asks.
