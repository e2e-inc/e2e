---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
'@e2e-dev/web': patch
---

Accept `app.permissions: 'all'` to grant every permission the target's engine can grant before each fresh launch: on Android every permission the app declares, on an iOS simulator every permission but `notifications` that its runtime supports (accept the notifications prompt with `device.alert('accept')`), and on the web every permission the browser grants. `device.openApp(app, { relaunch: true, permissions: 'all' })` does the same for one launch.
