---
"@e2e-dev/web": patch
---

Touchscreen emulation is turned on with `web({ hasTouch: true })`, so an app's touch handlers can be tested on a web target. A `tap` on a node or at a point is sent through Playwright's touchscreen as `touchstart` and `touchend`, and the browser follows with a click unless the app cancels the touch. On Chromium, a swipe along a path (`screen.swipe({ from, to })`) is sent as `touchstart`, `touchmove`, and `touchend`. In Firefox and WebKit it fails with `UNSUPPORTED_CAPABILITY`, since neither can send touch moves. Other actions are still sent as mouse and keyboard input, and the option is off by default. Like `userAgent`, it needs a newly created context, so `hasTouch: true` with `connect.reconnectEndpoint` or a browser provider with `scope: 'attempt'` is `INVALID_CONFIG`.
