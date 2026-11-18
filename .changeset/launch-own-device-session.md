---
'@e2e-dev/core': patch
---

Each `launch()` host now names its target after its platform and a random token (`ios-host-3f9a1c2e…`). Without a `session` option, two `mobile()` hosts, or a host and the test's own device, no longer drive one simulator under the same agent-device session.
