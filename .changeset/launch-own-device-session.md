---
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
---

Without a `session` option, two `mobile()` hosts from `launch()`, or a host and the test's own device, no longer drive one simulator under the same agent-device session. Each host hands its engine a random token as `hostId` in `prepare`, `init`, and `finish`, and the mobile engine names the host's session `e2e-<target>-<token>-<slot>`. A host that finds no free device now fails instead of sharing one. A host's artifact folders under `artifactsDir` are now named `core/host-<token>-<attempt id>`, so an engine platform that is a secret's value no longer reaches a path on disk.
