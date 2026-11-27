---
'@e2e-dev/desktop': patch
---

Without `headed`, `press` of a `ControlOrMeta` shortcut whose menu item is disabled now fails with `ACTION_FAILED` and names the item, instead of passing while the app ignored the key. macOS disables the menu items that act on the focused control or window (Select All, Find, Undo) while the app is in the background; use `desktop({ headed: true })` for those shortcuts.
