---
'@e2e-dev/web': patch
---

`browser.setCookies` checks each cookie against the `Cookie` type before the browser sees it, and refuses one it does not allow with `INVALID_ARGUMENT` naming the field. Before, a lowercase `sameSite: 'lax'`, a number `value` or a string `expires` was an `ENGINE_FAILURE` with exit code 3, a cookie with neither `url` nor `domain` failed with a bare `TypeError`, and one with both `url` and `domain` or `path` was set on the `url` with the `domain` and `path` silently dropped.
