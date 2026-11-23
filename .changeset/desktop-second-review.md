---
'@e2e-dev/desktop': patch
---

A read while the Mac's screen is locked retries instead of passing as an empty screen or a closed window.
`toBeEditable` reads a desktop text field and an editable combo box.
`desktop({ maxDepth })` takes 1 to 50, the depth agent-desktop reads.
A swipe on the window scrolls a custom view that offers scrolling.
A screenshot the Mac refused (no Screen Recording permission) no longer reads as masking that could not be proven.
`desktop.windows()` and the screen's location give the window's own title without Screen Recording permission, not the app's name.
Every screenshot withheld for a password field fails with `POLICY_DENIED`; one of a window with no password field that changed size during the capture is tried again.
`app.open()` reads again when the app replaces its window while the open reads it.
`@e2e-dev/desktop` now needs `@e2e-dev/core` and `e2e` 0.25.0 or later, since it reports the `readonly` state that is new there.
