---
'@e2e-dev/web': patch
---

`web({ dialogs: 'accept' | 'dismiss' })` answers every native dialog (`alert`, `confirm`, `prompt`, `beforeunload`) that no `browser.onDialog` handler takes, so `e2e explore` and `agent.act` steps, which can't register a handler, get past a confirmation such as "Delete this item?". An accepted `prompt` returns its default text, as clicking OK does. Each dialog the option answers is a line in the attempt's app log, so a message the app shows only in an `alert` stays in the report. A handler a test registers still comes first. Without the option, an unhandled dialog is still dismissed and fails the next step, and the error now names `browser.onDialog` and `web({ dialogs })` as the fixes.
