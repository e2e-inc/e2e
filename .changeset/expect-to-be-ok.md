---
'@e2e-dev/core': patch
'e2e': patch
---

`expect(response).toBeOK()` passes when a response's status is from 200 to 299. It takes what `request`, `browser.waitForResponse`, and `route.fetch()` return, and works with `.not`, `expect.soft`, and `expect.poll`. A value whose type is not `WebResponse`, such as `WebResponse | undefined`, does not compile; at run time, a value without a numeric `status` and a string `url` fails. A failure names the status and the response URL's origin and path, never its credentials, query, or fragment, and never reads the body.
