---
'@e2e-dev/desktop': patch
'@e2e-dev/desktop-darwin-arm64': patch
'@e2e-dev/desktop-darwin-x64': patch
---

Fixes in the desktop engine's macOS driver. `maxDepth` reads that many levels below the window, not one fewer. `getByRole('heading', { level })` finds a heading whose level is in its description. An outline row reads as expanded or collapsed. A scroll area with more than 16 children scrolls through its scroll bar. Text with a NUL character is read past the NUL. An app that does not answer for a window's title or state, or for what an untitled dialog holds, fails the window read with the retryable `APP_UNRESPONSIVE`, instead of reading the window as untitled, or Siri's dialog as one of the app's own. A locator `press` refused after it focused the control fails with `ACTION_MAY_HAVE_COMMITTED`. A hover at a point is no longer refused because a sheet opened elsewhere in the window, and a hover or double-click on a node with no ref no longer changes the window a later click at a point is checked against. A tap on a disabled control scrolled out of its list waits for it to be enabled before it scrolls.
