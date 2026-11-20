---
'@e2e-dev/core': patch
---

Each `launch()` host now names its target after its platform and a random token (`ios-host-<token>`), or `host-<token>` for a platform over 40 characters. Without a `session` option, two `mobile()` hosts, or a host and the test's own device, no longer drive one simulator under the same agent-device session.
