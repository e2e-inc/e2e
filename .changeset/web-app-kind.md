---
"e2e": patch
---

With `requires: ['web-app']`, a test runs on the targets with `app.url`.

Deprecated: the `browser` app kind for an `app.url`, since `browser` is also the name of the web engine's fixture. Use `web-app`. When only a target's `app.url` meets `requires: ['browser']`, a warning is printed. It will be removed no earlier than April 1, 2027. Then `requires: ['browser']` means only the `browser` fixture.
