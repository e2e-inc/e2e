---
'@e2e-dev/desktop': minor
---

**Breaking:** `desktop.useWindow()` takes a window's title, not its id: a string is the whole title, a `RegExp` matches part of it. It waits within the action timeout for a window that is still opening, fails naming the windows when two match, and lists the titles the app has when none shows. Pass a window from `desktop.windows()` (or `{ id }`) to pick one by id, as before.
