---
"@e2e-dev/core": patch
"@e2e-dev/mobile": patch
"@e2e-dev/web": patch
"e2e": patch
---

On iOS and Android, `toHaveScreenshot` now fails at once with `POLICY_DENIED` instead of waiting out its timeout when a secure field on screen has no bounds to mask, `app.screenshot()` fails with `POLICY_DENIED` there too, and an agent step reports `MASKING_UNPROVEN` for its screenshot.
