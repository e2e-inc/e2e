---
"@e2e-dev/core": patch
---

Do not replay a one-time code entered through `press` or `pressKey`; single-character keypresses are now treated as run-time input for one-time-code fields.
