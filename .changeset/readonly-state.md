---
"@e2e-dev/core": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

Report a `readonly` node state where a node can be read-only. The web engine decides it as Playwright's `getReadonly` does; the mobile engine reports it on a text field when agent-device says whether the field takes text.
