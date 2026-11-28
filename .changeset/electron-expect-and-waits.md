---
'@e2e-dev/electron': patch
'@e2e-dev/core': patch
---

`expect(electron)` asserts on the active window and retries, as `expect(browser)` does on the web: `toHaveURL`, `toHaveTitle`, `toHaveClass(locator, cls)`, and `toHaveCSS(locator, property, value)`, each with `.not` and `{ timeout }`. `electron.waitForURL(url)` waits for the window's URL, and `electron.waitForFunction(fn, arg)` runs a function in the window's page until it returns something truthy. [Wait and assert on the window](https://e2e.com/docs/electron#wait-and-assert-on-the-window)

For engine authors, a fixture's context has `expression(locator)`, which returns the expression of a locator the session made. [Fixtures](https://e2e.com/docs/reference/engine)
