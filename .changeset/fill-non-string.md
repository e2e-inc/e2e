---
'@e2e-dev/core': patch
---

`locator.fill` refuses a value that is neither a string nor a `Secret` with `INVALID_ARGUMENT` before it looks up the node, as `pressSequentially` does. Before, `fill(process.env.EMAIL)` with the variable unset, a number or `null` reached the engine, and the run reported Playwright's `value: expected string` as an `ENGINE_FAILURE` with exit code 3, as if the browser had broken.
