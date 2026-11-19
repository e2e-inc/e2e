---
"e2e": patch
"@e2e-dev/core": patch
---

`agent.waitFor` with `vision: 'only'` compares only the screenshot between judgments, the one thing the judge is shown, so a screen read that fell back to pixels alone no longer costs another model call.
