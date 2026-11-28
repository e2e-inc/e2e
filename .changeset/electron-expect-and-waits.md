---
'@e2e-dev/electron': patch
---

`expect(electron)` asserts on the active window and retries, as `expect(browser)` does on the web: `toHaveURL`, `toHaveTitle`, and `toHaveClass(locator, cls)`, each with `.not` and `{ timeout }`. `electron.waitForURL(url)` waits for the window's URL. [Wait and assert on the window](https://e2e.com/docs/electron#wait-and-assert-on-the-window)
