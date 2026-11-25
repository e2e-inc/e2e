---
'@e2e-dev/mobile': patch
---

On Android, React Native's `role="link"` (which expo-router's `Link` sets) is a `link`, as on iOS, where it used to be a `group` or a `button`, and a `Text` link matches its name once.
