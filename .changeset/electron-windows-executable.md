---
'@e2e-dev/electron': patch
---

On Windows, `electron({ executablePath })` must name the app's `.exe`. A shortcut, a script, a folder, a path without `.exe`, or the launcher a Squirrel installer leaves beside the app now fails the config check and `e2e doctor`, with the file to name instead.
