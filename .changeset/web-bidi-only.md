---
"@e2e-dev/web": minor
---

**Breaking:** the web engine drives Chromium and Firefox over WebDriver BiDi and no longer uses Playwright. Tests, fixtures, and `web()` options stay the same, except:

- WebKit is gone: `web({ browser: 'webkit' })` is `INVALID_CONFIG`.
- Lightpanda no longer works: with `lightpanda()` or `connect` to a Lightpanda server, a test that opens a page times out. Run those targets on `chromium`.
- Moli reads a page but cannot act on it: with `moli()` or `connect` to a Moli server, an action on an element fails with `ACTION_FAILED` or `LOCATOR_NOT_FOUND`, and a screenshot throws `ENGINE_FAILURE`. Run those tests on `chromium`.
- `surfaceOf` and `PlaywrightLiveSurface` are removed, so there is no raw Playwright `Page` or `BrowserContext` to reach for.
- `browser.locator` takes CSS and XPath, alone or in `>>` chains: no `text=`, `nth=`, or other Playwright engines. Chain `nth()` and screen queries instead.
- `getByRole('textbox')` finds a `contenteditable` host whatever its tag, and the tag's own role no longer does: `getByRole('heading')` does not find an `<h1 contenteditable>`. `getByRole` also finds a control with only an icon by its `title`. A query that matched one node before can now match two.
- `connect.reconnectEndpoint` and `BrowserLease.reconnectEndpoint` are removed, and `reconnectEndpoint` in `connect` is `INVALID_CONFIG`: a dropped connection fails the attempt, and the next attempt attaches again through `cdpEndpoint`. A host that cannot create a browser context, such as an Electron app, takes `connect: { cdpEndpoint, context: 'existing' }` instead: the test drives the page the host already shows.
- With a `scope: 'attempt'` browser provider, `headers`, `basicAuth`, `userAgent`, `locale`, and `timezoneId` are no longer `INVALID_CONFIG`. `app.clearState()` still throws `UNSUPPORTED_CAPABILITY` there, and a test that uses a saved session still fails collection with `COLLECTION_ERROR`: the attempt runs in the fresh browser's own context.
- `keyboard.type` fails instead of dropping a character no key types, such as an emoji or an accented letter, when what holds focus takes keys but not text.
- `browser.mouse.move` and `wheel` throw `INVALID_ARGUMENT` for a point outside the viewport, and `waitForResponse` reads no body over 20 MB (`body()` throws `ACTION_FAILED`).
- `setInputFiles` on a browser provider's browser sends the files' bytes to the page, up to 50 MB in all; a directory there throws `UNSUPPORTED_CAPABILITY`. A download on a provider without `downloads` is read from this machine, as before; when the browser saved it on another machine, the wait throws `UNSUPPORTED_CAPABILITY` (it was `ENGINE_FAILURE`).
- On Firefox, `browser.emulateMedia({ reducedMotion })` (set `web({ reducedMotion })` instead), `route.continue({ url })`, and a drag that starts an HTML5 drag throw `UNSUPPORTED_CAPABILITY`. The web reference lists the limits of each browser.
- Setting `headers` no longer turns the browser's HTTP cache off. A route still does: while the attempt has a route every request asks the network, and the cache answers again once the last route is removed.
- Browsers are new pinned builds: Chrome for Testing 157.0.8103.38 (the headless shell, or full Chrome when headed) and Firefox 159.0.1. They install into `E2E_BROWSERS_PATH`, else `e2e/browsers` in the user cache, with `npx @e2e-dev/web install [chromium|firefox] [--with-deps] [--headed]`, or on the first run. `PLAYWRIGHT_BROWSERS_PATH` is no longer read.
- Chromium video needs an ffmpeg with VP9: `E2E_FFMPEG_PATH`, else the pinned build once it is in the browser cache, else `ffmpeg` on the `PATH`. With none of them, the first recording downloads the pinned build into the browser cache (`npx @e2e-dev/web install ffmpeg` fetches it ahead). A run that records no video never downloads it.
- The old `ms-playwright` browser cache is no longer used and can be deleted.
- Every browser and ffmpeg archive is checked against a pinned SHA-256 before it is unpacked. `E2E_BROWSERS_DOWNLOAD_HOST` names an `https` mirror (plain `http` only on `localhost`) serving the Chrome for Testing, Mozilla archive, and ffmpeg-static paths. Downloads honor `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` (on Node 22 and Node 24 before 24.14, with `NODE_USE_ENV_PROXY=1`).
- Concurrent installs into one cache wait for each other and say so; one whose owner died or stopped responding is taken over. Ctrl-C or SIGTERM during `e2e-web install` stops the download, removes the partial files, and exits 130 or 143. On Linux, `--with-deps` also installs `xz-utils`, which unpacking Firefox needs.
