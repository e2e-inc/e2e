---
"e2e": patch
"@e2e-dev/core": patch
---

A standalone session opened while a run is in progress, such as `attachBrowser()` inside a test, no longer hides the run's secrets while it is open or clears them when it closes. `app.resolveUrl` resolves an absolute URL on a target with no `app.url`; a relative one is still `APP_URL_REQUIRED`.
