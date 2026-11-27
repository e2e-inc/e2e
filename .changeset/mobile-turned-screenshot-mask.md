---
'@e2e-dev/mobile': patch
---

Withhold a screenshot with a secure field on screen when the image comes back turned 90 degrees from the screen, as an iOS simulator's capture can in landscape. The masks were scaled and painted in landscape coordinates onto the portrait image, which left the field visible. `app.screenshot()` and `locator.screenshot()` now fail with `POLICY_DENIED`, as does `toHaveScreenshot()`, and an agent step's observation goes without pixels.
