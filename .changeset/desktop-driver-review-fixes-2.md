---
'@e2e-dev/desktop': patch
'@e2e-dev/desktop-darwin-arm64': patch
'@e2e-dev/desktop-darwin-x64': patch
---

More fixes in the desktop engine and its macOS driver.

Windows:
- `desktop.windows()` and a window's reads read the windows again while the app does not answer or the screen is locked, instead of reading an open window as closed.
- A window's sheet is part of it, not an extra window. The active window is the one `screen` reads.
- `desktop.window({ title })` keeps a sticky RegExp anchored.
- `waitForWindow` counts the whole call toward its timeout, takes a window found up to its end and none a read brings back after it, and activates the window it found though the app stalls once.
- `window.close()` waits for a window that saves before it closes, and leaves alone a window whose app quit with it. One it cannot reach while the app runs fails as retryable `NODE_STALE`, not as closed.

Input:
- A locator `press` on a control that already had focus, refused, fails as nothing sent; one a run cancelled fails as `CANCELLED`.
- A disabled control is waited for through a short timeout.
- A fill a stepper can never take is refused before the control scrolls into view.
- `selectOption` waits for a disabled list row.
- A hover is not refused because another of the app's windows took focus.
- A swipe on a scroll area that holds its rows directly moves it by the pages asked for.

Reads:
- An outline row that can expand reads as collapsed when it is.
- A heading's level is read only from "heading level N".
- A close button in a borderless window's content is read.
- A read cut at `maxDepth` names the depth limit when typing or a window swipe finds nothing.

Processes:
- Every test quits the processes the app started with it, also when the app quit right after its launch.
- A quit's timeout counts from its call.
- A launch record stays while its launch may still start the app.
