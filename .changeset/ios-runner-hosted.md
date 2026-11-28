---
'@e2e-dev/mobile': patch
---

On a hosted iOS device whose provider runs the automation runner itself, such as Revyl's, `prepare` no longer logs "automation runner not prepared" for the runner step the device refuses, and it opens the pinned app on the slot as on any other device.
