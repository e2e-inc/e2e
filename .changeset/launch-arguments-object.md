---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
'@e2e-dev/web': patch
---

`app.launchArguments`, and `launchArguments` on `device.openApp`, also take an object of argument name to string, number, boolean, or list of strings, such as `{ AppleLanguages: ['fr'], AppleLocale: 'fr_FR' }`. `mobile()` writes each entry as `-name value` on iOS, a list as `-name (a, b)`, and on Android as an `am start` extra of the value's type: `--es` for a string, `--ez` for a boolean, `--ei` for a number, `--esa` for a list. An object with one of Apple's arguments, such as `AppleLocale`, on an Android target fails at config load. A list of strings still goes to the launch command as given.
