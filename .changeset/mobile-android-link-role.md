---
'@e2e-dev/mobile': patch
---

On Android, React Native's `role="link"` (which expo-router's `Link` sets) is a `link` now instead of a `group` or a `button`, as it is on iOS, and a `Text` link matches its name once.
