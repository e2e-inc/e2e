---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
'@e2e-dev/web': patch
---

`app.launchArguments`, and `launchArguments` on `device.openApp`, also take an object of argument name to string, number, boolean, or list of strings, such as `{ AppleLanguages: ['fr'], AppleLocale: 'fr_FR' }`. `mobile()` writes each entry as `-name value` on iOS, quoting a string `NSUserDefaults` would read as a plist, and a list as `-name (a, b)`. On Android each entry is an `am start` extra of the value's type: `--es` for a string, `--ez` for a boolean, `--ei` for a whole number (`--el` beyond Java's `int`), `--ef` for a fraction, `--esa` for a list. An object on an Android target fails at config load when it holds one of Apple's arguments, such as `AppleLocale`, or a list `am start` would read back changed: an empty list, or an item that is empty, holds a comma, or ends in a backslash. `device.openApp` checks its `launchArguments` the same way and fails with `INVALID_ARGUMENT`. A list of strings still goes to the launch command as given. `@e2e-dev/core/engine` exports the shape check as `checkLaunchArguments`.
