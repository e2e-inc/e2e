---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/desktop': patch
---

`e2e mcp`: a `run_code` call of an engine fixture whose argument holds only while the app runs is written in `test_lines` the way the engine says a test finds the same thing again. `desktop.useWindow(window)` is written as `desktop.useWindow((await desktop.windows()).find((window) => window.title === "Inbox") ?? "titled Inbox")` rather than with the window's id, which no longer exists on the next launch; with no window of that title, `useWindow` fails instead of going back to the focused window. An engine declares this with the new `testLine` field of a fixture operation, in `@e2e-dev/core/engine`.
