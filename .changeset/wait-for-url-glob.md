---
"@e2e-dev/web": patch
---

`browser.waitForURL` takes a URL glob such as `'**/checkout'`, as Playwright's does: a string is a glob, with `?` read literally, so one with no wildcard is still an exact match, and the empty string matches any URL. `expect(browser).toHaveURL` keeps comparing a string exactly, as Playwright's does.

`browser.route`, `unroute`, and `waitForResponse` now read the same Playwright globs: in their patterns `?` is literal instead of one character, `{a,b}` matches either, `''` matches every URL, so `route('')` intercepts every request, a relative pattern resolves against the app URL instead of never matching, and a pattern ending in `**` right after the host, such as `route('http://x.test**')`, now matches only URLs that end in `/`. A pattern is also normalized like a URL, so `'http://x.test'` matches `http://x.test/`, its scheme and host match in any case, and `/a/../b` reads as `/b`. A `**/` segment may match none, so `'**/a/**/b'` matches `/a/b`, and `waitForURL`, `route`, and `waitForResponse` reject an unbalanced `{` or `}` with `INVALID_ARGUMENT`.
