/**
 * `@e2e-dev/web/engine`: the `web()` factory and its types, without `test`,
 * so a program that drives a browser with `@e2e-dev/core` never loads the test
 * runner. The main entry re-exports all of it beside `test`.
 */

export { web } from './engine.ts';
/** The engine factory again, as the default export: what `e2e mcp` calls when `open_session` names this package as its `engine`. */
export { web as default } from './engine.ts';
export { attachBrowser, type AttachBrowserOptions, type AttachedBrowser } from './attach.ts';
export type { CdpTarget, WebBasicAuth, WebConnectOptions, WebMedia, WebOptions, WebScreencastOptions } from './options.ts';
export type { WebInitScript } from './init-scripts.ts';
export type {
  BrowserDownloadContext,
  BrowserLease,
  BrowserProvider,
  BrowserProviderDownloads,
  BrowserProviderScope,
  BrowserReleaseContext,
  BrowserRequest,
} from './provider.ts';
export { releaseEach } from './sweep.ts';
export type { SweepOutcome } from './sweep.ts';
export type { BrowserName } from './browsers.ts';
export type {
  Browser,
  BrowserExpectation,
  BrowserTab,
  Cookie,
  CookieFields,
  CookieFilter,
  Dialog,
  DialogHandler,
  FrameScreen,
  RouteContinueOverrides,
  RouteFulfillResponse,
  WebResponse,
  WebRoute,
} from './fixture/types.ts';

export type { WebApp, WebFixtures } from './fixtures.ts';
