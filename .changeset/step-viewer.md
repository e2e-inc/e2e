---
"e2e": patch
"@e2e-dev/github": patch
"@e2e-dev/html-reporter": patch
---

Prompt keys are now below the live summary during `--step` and `screen.pause()`.
The screen is available with `s` and the app log with `l`.
Time spent at a held step or pause is excluded from the terminal's `Duration` row and the report's `run.durationMs`.
The run timestamps still use wall time.
