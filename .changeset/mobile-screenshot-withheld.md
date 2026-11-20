---
"@e2e-dev/core": patch
"@e2e-dev/mobile": patch
"@e2e-dev/web": patch
"e2e": patch
---

On iOS and Android, a secure field on screen with no bounds to mask now fails `toHaveScreenshot` and `app.screenshot()` at once with `POLICY_DENIED`, and an agent step reports `MASKING_UNPROVEN` for its screenshot.
