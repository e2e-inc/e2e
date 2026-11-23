---
"@e2e-dev/web": patch
---

`web({ hasTouch: true })` emulates a touchscreen, so a test reaches an app's touch handlers. A `tap`, on a node or at a point, goes through Playwright's touchscreen and sends `touchstart` and `touchend`, and the browser then clicks unless the app cancels the touch. A swipe along a path (`screen.swipe({ from, to })`) sends `touchstart`, `touchmove`, and `touchend` over CDP on Chromium; in Firefox and WebKit it fails with `UNSUPPORTED_CAPABILITY`, since they cannot send touch moves. Every other action stays mouse and keyboard input. The default stays `false`. Like `userAgent`, the option needs a newly created context, so it is `INVALID_CONFIG` with `connect.reconnectEndpoint` or a browser provider with `scope: 'attempt'`.
