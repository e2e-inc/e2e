---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/acp': patch
---

`agent.waitFor`, `agent.extract`, and `e2e explore` run on Claude Code or Codex through `@e2e-dev/acp` with no model configured, so an agents entry that is only `{ executor: claudeCode() }` covers every agent step. A `StepExecutor` gets two optional members for this: `answer(question)` answers a judgment when the entry has no `judge` or `model`, and `extend({ system, tools })` returns a copy with guidance and `defineTool` tools added, which explore uses for its rules and `report_finding`. An executor without `extend` is still replaced by the built-in agent in explore. `createProjectTools` from `e2e/agent` runs `defineTool` tools under a step's accounting. `redactProviderKeys` from `e2e/agent` redacts only provider keys from text the run already redacted. [Use your coding agent](https://e2e.com/docs/subscriptions#use-your-coding-agent)
