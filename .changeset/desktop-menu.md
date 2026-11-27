---
'@e2e-dev/desktop': patch
---

Added `desktop.menu(...titles)`, which chooses an item of the app's menu bar by its titles, such as `desktop.menu('Edit', 'Find', 'Find…')`, without opening the menu on screen. A command that has no shortcut is now reachable, and an item the app itself handles works while the app stays in the background.
