---
"e2e": patch
"@e2e-dev/core": patch
"@e2e-dev/mobile": patch
"@e2e-dev/web": patch
"@e2e-dev/desktop": patch
"@e2e-dev/testmu": patch
"@e2e-dev/browserstack": patch
---

Run a device app in another language with `app.locale`, a BCP 47 tag such as `fr-FR`. Every fresh launch of the target's app runs in it, and `device.openApp(app, { relaunch: true, locale })` sets it for one launch.

- On iOS the locale is the launch's `AppleLanguages` and `AppleLocale` arguments, so it works wherever the launch carries arguments: a simulator, a phone agent-device drives through devicectl, and a hosted device whose provider keeps them. A phone driven through XCTest refuses launch arguments with `UNSUPPORTED_CAPABILITY`. A target that also sets those two in `launchArguments` fails at config load.
- On Android the engine sets the app's own language with this machine's `adb` (`cmd locale set-app-locales`, Android 13 and newer) before the launch, and puts back the app's earlier language on a later fresh launch without a locale and at the end of the run. On a device provider's Android devices `app.locale` fails at config load: set `language` and `locale` on the provider.
- A `DeviceProvider` declares `launchArguments: false` when its devices drop launch arguments. `testmu()` and `browserstack()` do, since agent-device drives them over Appium WebDriver, so `app.locale` on their iOS devices fails at config load too, rather than run the app in the device's own language. An older `@e2e-dev/testmu` or `@e2e-dev/browserstack`, which does not declare it, does not refuse: update them with `@e2e-dev/mobile`.

An engine opts in with `appLocale: true` and receives `EngineAppInfo.locale`. For an engine that does not declare it, including a `@e2e-dev/mobile` released before this change, config load refuses `app.locale` with `INVALID_CONFIG`. `@e2e-dev/mobile` now needs `@e2e-dev/core` and `e2e` 0.25.1.
