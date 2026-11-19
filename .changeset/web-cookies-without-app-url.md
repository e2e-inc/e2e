---
"@e2e-dev/web": patch
---

`browser.setCookies` sets a cookie that names a full `url` or a `domain` on a target with no `app.url`, such as `attachBrowser`. A cookie with neither fails with `INVALID_ARGUMENT` naming the cookie.
