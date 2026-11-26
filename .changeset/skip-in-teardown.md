---
"e2e": patch
---

`test.skip()` or `test.fixme()` in an `afterEach` hook or a fixture teardown now fails a test that did not skip with `INVALID_ARGUMENT`, as a late `test.fail()` does, instead of `ERROR: [object Object]`; a test marked `test.fail()` fails on it too. After a skipped test it records no error, but, as anywhere, nothing after the call in that hook or teardown runs.
