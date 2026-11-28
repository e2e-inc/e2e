---
'@e2e-dev/mobile': patch
---

On Android, React Native's `role="link"` (which expo-router's `Link` sets) is a `link` now instead of a `group` or a `button`, as it is on iOS, and a `Text` link matches once. Before React Native 0.84, Android names a `Text` link by its text, even when an `accessibilityLabel` gives it a different name on iOS.
