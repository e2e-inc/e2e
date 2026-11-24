---
'@e2e-dev/core': patch
'e2e': patch
---

`expect(response).toBeOK()` passes when a response's status is from 200 to 299. It takes what `request`, `browser.waitForResponse`, and `route.fetch()` return, works with `.not`, `expect.soft`, and `expect.poll`, and does not compile on any other value. A failure names the status and the URL without its query, and never reads the body.
