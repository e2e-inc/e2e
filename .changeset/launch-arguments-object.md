---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
'@e2e-dev/web': patch
---

`app.launchArguments` also takes an object of argument name to string, number, boolean, or list of strings, such as `{ AppleLanguages: ['fr'], AppleLocale: 'fr_FR' }`. `mobile()` writes each entry as `-name value` on iOS and `--es name value` on Android, and refuses Apple's arguments on an Android target at config load. A list of strings is also supported.
