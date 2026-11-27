---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
---

An engine operation now carries `agentStep`, an id of the `agent.act` step it belongs to, on every operation of the step, replayed from the cache as well as live, where `origin` is `test`. An engine may scope state to one agent step with it; the desktop engine follows a window an agent step opened only within that step.
