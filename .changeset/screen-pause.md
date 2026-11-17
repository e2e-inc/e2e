---
'e2e': patch
'@e2e-dev/core': patch
---

Add `screen.pause()` to pause a test at a line, with the app open, until you
resume it: press Enter in the terminal, or run `e2e run --step next` from
another shell in the same directory. With `CI` set, or in a run that the MCP
`run_tests` tool started, the test fails with `PAUSE_UNAVAILABLE`.
