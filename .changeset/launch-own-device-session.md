---
'@e2e-dev/core': patch
---

Each `launch()` host now names its target after its platform, the process, and the host's number (`ios-launch-4182-2`), so two mobile hosts, or a host and the test's own device, no longer drive one simulator under the same agent-device session.
