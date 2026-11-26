---
'@e2e-dev/core': patch
'e2e': patch
---

An agent action's result now lists what the engine logged as the `system` source during the action, under the screen: the newest five lines, redacted. With `web({ dialogs })` set, an explorer or an `agent.act` step reads the message of each native dialog the option answered, such as an app's error `alert`, which no screen shows. Custom executors get the same lines as `systemLog` on the observation.
