---
'@e2e-dev/web': patch
---

`browser.waitForResponse` takes a predicate, and the new `browser.waitForRequest` waits for a request by URL pattern, `{ method, url }`, or predicate, as Playwright's `page.waitForResponse` and `page.waitForRequest` do. The response it returns carries the request it answers as `request`, typed `PageResponse`; the request is a `WebRequest`, the type a route handler reads as `route.request`. Both waits refuse an option other than `timeout`.
