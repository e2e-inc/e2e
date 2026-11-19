---
"@e2e-dev/core": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

Report a `readonly` node state where a node can be read-only. The web engine decides it as Playwright's `getReadonly` does; the mobile engine reports it on a text field when agent-device says whether the field takes text.

The web and mobile engines now need `@e2e-dev/core` and `e2e` 0.24.1 or later, since `toBeEditable` reads this state. Agent observations and the MCP catalog now show `[readonly]` on such nodes, so the model can see a field it can't type into.
