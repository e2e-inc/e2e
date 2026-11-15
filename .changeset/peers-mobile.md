---
"@e2e-dev/mobile": patch
---

A test's peer on a device target takes a simulator or emulator of its own from the pool: `prepare` binds one device per worker and one per peer. A run that puts a peer on a target with a device provider fails before any test with `UNSUPPORTED_CAPABILITY`, before anything is leased. `mobileTools` calls from a peer's agent act on the peer's own device.
