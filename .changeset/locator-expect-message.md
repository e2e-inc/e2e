---
'e2e': patch
'@e2e-dev/core': patch
---

`expect(locator, message)` and `expect.soft(locator, message)` take an optional message, as value expectations already do. It opens the failure of every locator matcher, `.not` and `toHaveScreenshot` included: `the cart is empty: expect.toBeVisible failed`.
