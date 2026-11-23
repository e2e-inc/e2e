---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
---

`app.launchArguments` and `device.openApp({ launchArguments })` also take an object of argument name to string, number, boolean, or list of strings, such as `{ AppleLanguages: ['fr'], AppleLocale: 'fr_FR' }`. Write a name without its leading dash: `{ AppleLocale: 'fr_FR' }`, not `{ '-AppleLocale': 'fr_FR' }`, which fails at config load. On iOS, `mobile()` sends each entry as `-name value`, and so does `desktop()` on macOS. On Android, each entry is an `am start` extra of the value's type: `--es`, `--ez`, `--ei` (`--el` beyond Java's `int`), `--ef`, or `--esa` for a list. An Android object fails when it holds one of Apple's arguments, such as `AppleLocale`, or a list that `am start` would change: an empty list, or an item that is empty, holds a comma, or ends in a backslash. A list of strings still goes to the launch command as given. `EngineAppInfo.launchArguments` is now `ResolvedLaunchArguments`, so an engine can receive an object; `@e2e-dev/core/engine` exports the type, the shape check `checkLaunchArguments`, and `appleUserDefaults`, which spells an object as `-name value` arguments for an iOS or macOS app.
