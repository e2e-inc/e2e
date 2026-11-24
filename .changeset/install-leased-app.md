---
'@e2e-dev/mobile': patch
---

`@e2e-dev/mobile/lease` exports `installLeasedApp(request, lease)`, which installs the request's `appPath` through the lease's daemon and returns the lease with `installedApp`. `device.installApp()` now installs nothing for the target's build when the device provider already installed it, so one install fixture serves local and hosted devices; `reinstall: true` and other builds still install.
