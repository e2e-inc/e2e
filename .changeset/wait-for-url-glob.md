---
"@e2e-dev/web": patch
---

`browser.waitForURL` takes a URL glob such as `'**/checkout'`, as Playwright's does: a string is a glob, with `?` read literally, so one with no wildcard is still an exact match, and the empty string matches any URL. `expect(browser).toHaveURL` keeps comparing a string exactly, as Playwright's does.

`browser.route`, `unroute`, and `waitForResponse` now read the same Playwright globs: in their patterns `?` is literal instead of one character, `{a,b}` matches either, and a relative pattern resolves against the app URL instead of never matching.
