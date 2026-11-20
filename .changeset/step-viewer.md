---
"e2e": patch
"@e2e-dev/github": patch
"@e2e-dev/html-reporter": patch
---

`--step` and `screen.pause()` keys now appear below the live summary, with `s` for the screen and `l` for the app log.
The terminal's `Duration` row and the report's new `run.durationMs` field show the run duration without paused time.
