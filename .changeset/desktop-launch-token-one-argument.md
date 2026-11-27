---
'@e2e-dev/desktop': patch
---

An app whose environment macOS hides gets its launch token as one argument, `-E2EDesktopLaunch=<token>`, where it got two (`-E2EDesktopLaunch <token>`). A Chromium browser opened the bare token as a URL in an extra tab, and other apps could take it as a file to open. [Point at your app](https://e2e.com/docs/desktop#point-at-your-app)
