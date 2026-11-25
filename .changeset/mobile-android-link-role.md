---
'@e2e-dev/mobile': patch
---

On Android, a node described as a `Link` is a `link`, as it is on iOS. React Native describes `role="link"` (or `accessibilityRole="link"`), which expo-router's `Link` sets, that way. Such a node used to keep its type's role, `group` for a React Native link, so `getByRole('link', name)` matched nothing on Android. The `Button` React Native adds for a link inside a `Text` is a `link` now too, and `getByRole('button', name)` no longer matches it. Before React Native 0.84 a `Text` link holds such a `Button` under its own name; that `Button` is the `link`, and the `Text` stays a `group`, so the name matches once.
