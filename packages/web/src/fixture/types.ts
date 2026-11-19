/**
 * The `browser` fixture's public types: the browser-shaped deterministic
 * surface this engine contributes, its routes, responses, cookies, dialogs,
 * and the `expect(browser)` matchers. They live in this package, not in
 * core, because the harness knows the engine contract and never a platform's
 * fixture shape. A project that installs the package compiles them, so they
 * are declared here in full and import nothing from the driver, whose types
 * name the protocol packages only this workspace installs.
 */

import type { ActionOptions, Expectable, JsonValue, Locator, Screen, TextMatch } from '@e2e-dev/core';
import type { WebMedia } from '../options.ts';

/** What every cookie carries, whichever way it names its site. */
export interface CookieFields {
  /** Cookie name. */
  name: string;
  /** Cookie value. */
  value: string;
  /** Unix timestamp in whole seconds. */
  expires?: number;
  /** HttpOnly flag. */
  httpOnly?: boolean;
  /** Secure flag. */
  secure?: boolean;
  /** SameSite attribute. */
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** `url`, or `domain` with an optional `path`, never both. */
export type Cookie = CookieFields &
  (
    | { url: string; domain?: never; path?: never }
    | { url?: never; domain: string; path?: string }
  );

/** Cookie filters are combined; strings match exactly, RegExp matches the field. */
export interface CookieFilter {
  name?: string | RegExp;
  domain?: string | RegExp;
  path?: string | RegExp;
}

/** A native dialog as a test's handler sees it. */
export interface Dialog {
  /** The native dialog kind, independent of its message. */
  readonly type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  /** The dialog's text. */
  readonly message: string;
  /** Accepts the dialog once. */
  accept(text?: string): Promise<void>;
  /** Dismisses the dialog once. */
  dismiss(): Promise<void>;
}

export type DialogHandler = 'accept' | 'dismiss' | ((dialog: Dialog) => void | Promise<void>);

/**
 * One of `json`, `body`, or `path`, or none for an empty body. `path` names a
 * file relative to the project root; its `Content-Type` follows its
 * extension unless `contentType` or a `content-type` header sets one.
 */
export type RouteFulfillResponse = {
  status?: number;
  /** Response headers; `set-cookie` may join several cookies with `\n`, as `route.fetch()` reports them. */
  headers?: Record<string, string>;
  /** Sets the `Content-Type` response header. */
  contentType?: string;
} & (
  | { json: JsonValue; body?: never; path?: never }
  | { body: string | Uint8Array; json?: never; path?: never }
  | { path: string; json?: never; body?: never }
  | { body?: never; json?: never; path?: never }
);

/** What `continue` changes about the request before it goes to the network. */
export interface RouteContinueOverrides {
  /** Resolved against the base URL like `goto`; must keep the request's scheme. */
  url?: string;
  /** Request method. */
  method?: string;
  /** Replaces every request header; `undefined` drops one, and the configured `headers` for an allowed origin are added on top. */
  headers?: Record<string, string | undefined>;
  /** Request body. */
  postData?: string;
}

export interface WebRoute {
  /** The intercepted request. */
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    /** The body's bytes decoded as UTF-8; absent for a request without one, or one the browser reports no bytes for. */
    readonly postData?: string;
  };
  /** Reads the upstream response without deciding the route or following redirects. */
  fetch(): Promise<WebResponse>;
  /** Fulfills the intercepted request once. */
  fulfill(response: RouteFulfillResponse): Promise<void>;
  /** Sends the intercepted request to the network once, skipping every other route. */
  continue(overrides?: RouteContinueOverrides): Promise<void>;
  /** Hands the intercepted request to the route registered before this one, or the network when none matches. */
  fallback(): Promise<void>;
  /** Aborts the intercepted request once. */
  abort(): Promise<void>;
}

export interface WebResponse {
  /** Response URL. */
  readonly url: string;
  /** HTTP status. */
  readonly status: number;
  /** Response headers, lower-cased names; `route.fetch()` joins several `set-cookie` values with `\n`, `waitForResponse` leaves cookie headers out. */
  readonly headers: Readonly<Record<string, string>>;
  /** Waits for the body and returns its bytes; rejects with `ACTION_FAILED` when the body could not be read. */
  body(): Promise<Buffer>;
  /** Waits for the body and parses it as JSON; rejects with `ACTION_FAILED` when the body could not be read. */
  json<T = unknown>(): Promise<T>;
  /** Waits for the body and reads it as text; rejects with `ACTION_FAILED` when the body could not be read. */
  text(): Promise<string>;
}

export interface BrowserExpectation {
  /** Inverts the matcher. */
  readonly not: BrowserExpectation;
  /** Waits for the current URL to match; `ignoreCase` compares a string case-insensitively and adds the `i` flag to a RegExp, `false` removes it. */
  toHaveURL(expected: string | RegExp, options?: { ignoreCase?: boolean; timeout?: number }): Promise<void>;
  /** Waits for the current title to match. */
  toHaveTitle(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
  /** Waits for the target's `class` attribute to match: a string is the whole normalized class list, a RegExp is tested against it. */
  toHaveClass(target: Locator, expected: TextMatch, options?: { timeout?: number }): Promise<void>;
}

/**
 * The screen scope `browser.frameLocator` returns. Every `Screen` query answers
 * from inside the frame, and the web-only escape hatches follow it in: `locator` for a CSS or XPath
 * selector on a control with no accessible name, `frameLocator` for a frame
 * nested inside this one.
 */
export interface FrameScreen extends Screen {
  /** Creates a web-only CSS or XPath locator inside this frame. */
  locator(selector: string): Locator;
  /** Creates a screen query scope inside an iframe nested in this frame. */
  frameLocator(selector: string): FrameScreen;
}

/**
 * One tab of the browser the attempt drives: the attempt's own, one the app
 * opened, or one `browser.newTab` opened. The same tab is the same object for
 * the whole attempt.
 */
export interface BrowserTab {
  /** Returns the tab's current URL. */
  url(): Promise<string>;
  /** Returns the tab's current title. */
  title(): Promise<string>;
  /** Whether this is the active tab, the one `screen`, `expect`, and the browser's page methods act on. */
  isActive(): boolean;
  /** Whether the tab has closed. */
  isClosed(): boolean;
  /** Makes this the active tab. Rejects with `ACTION_FAILED` when it has closed. */
  activate(): Promise<void>;
  /**
   * Closes the tab. When it was the active tab, the tab that opened it becomes
   * active, else the open tab that was active most recently.
   */
  close(): Promise<void>;
}

/**
 * The browser the attempt drives, showing one active tab. Navigation, reads,
 * `locator`, `frameLocator`, `evaluate`, `waitForResponse`, `waitForDownload`,
 * the keyboard and mouse, `expect(browser)`, and `screen` act on the active
 * tab; cookies, routes, and dialog handlers cover the whole browser, every
 * tab included. A tab the app opens (a `target="_blank"` link,
 * `window.open`) joins `tabs()` but does not become active on its own:
 * `waitForPopup` makes the tab its trigger opens active, and `activate`
 * any other. When the active tab closes, the tab that opened it is active
 * again.
 */
export interface Browser extends Expectable<BrowserExpectation> {
  /** Navigates to an allowed URL. */
  goto(
    url: string,
    options?: {
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
      timeout?: number;
    },
  ): Promise<void>;
  /** Reloads the current document. */
  reload(options?: ActionOptions): Promise<void>;
  /** Navigates browser history back once. */
  back(options?: ActionOptions): Promise<void>;
  /** Navigates browser history forward once. */
  forward(options?: ActionOptions): Promise<void>;
  /** Returns the current URL. */
  url(): Promise<string>;
  /** Returns the current title. */
  title(): Promise<string>;
  /** Waits for the current URL to match. */
  waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void>;
  /** Creates a web-only CSS or XPath locator. */
  locator(selector: string): Locator;
  /** Creates a screen query scope inside one iframe. */
  frameLocator(selector: string): FrameScreen;
  /** Evaluates trusted test code in the page: a function, or a string expression whose value is returned, called first if it is a function. */
  evaluate<T extends JsonValue>(fn: string | (() => T | Promise<T>)): Promise<T>;
  /** Evaluates trusted test code with one required JSON-safe argument. */
  evaluate<T extends JsonValue, Arg extends JsonValue>(
    fn: string | ((arg: Arg) => T | Promise<T>),
    arg: Arg,
  ): Promise<T>;
  /**
   * Adds a script every document runs before the page's own, from the next
   * navigation on: JavaScript source, a `{ path }` relative to the project
   * root, or a function.
   */
  addInitScript(script: string | { path: string } | (() => unknown)): Promise<void>;
  /** Adds an init script function called with one JSON argument. */
  addInitScript<Arg extends JsonValue>(script: (arg: Arg) => unknown, arg: Arg): Promise<void>;
  /** Adds an attempt-scoped network route. */
  route(
    pattern: string | RegExp,
    handler: (route: WebRoute) => void | Promise<void>,
  ): Promise<void>;
  /** Removes matching attempt-scoped routes. */
  unroute(pattern: string | RegExp): Promise<void>;
  /** Removes all routes registered by this browser fixture, preserving the configured headers. */
  unrouteAll(): Promise<void>;
  /** Waits for a matching response. */
  waitForResponse(
    pattern: string | RegExp,
    options?: { timeout?: number },
  ): Promise<WebResponse>;
  /** Returns cookies visible to the current context. */
  cookies(): Promise<Cookie[]>;
  /** Sets cookies after URL validation. */
  setCookies(cookies: readonly Cookie[]): Promise<void>;
  /** Removes matching cookies only; without filters removes every cookie, preserving other storage. */
  clearCookies(options?: CookieFilter): Promise<void>;
  /** Sets the viewport size. */
  setViewport(size: { width: number; height: number }): Promise<void>;
  /**
   * Emulates CSS media features on every open tab and every tab opened after
   * them, the app's own included, for the rest of the attempt, as Playwright's
   * `page.emulateMedia` does: the page's `@media` rules and `matchMedia` both
   * read them. A feature left out keeps its value. Works before the first
   * navigation, so the page loads with them. Firefox changes only
   * `colorScheme`; `reducedMotion` there throws `UNSUPPORTED_CAPABILITY`.
   */
  emulateMedia(media: WebMedia): Promise<void>;
  /** Registers an attempt-scoped dialog handler and returns an unsubscribe function. */
  onDialog(handler: DialogHandler): Promise<() => Promise<void>>;
  /** Returns the open tabs, in the order they opened. */
  tabs(): readonly BrowserTab[];
  /**
   * Runs a trigger and waits for the tab it opens, then resolves with that
   * tab once it is the active tab. The wait takes the first tab the app
   * opens after it starts, which can be one an earlier action opened whose
   * page loaded only now. Rejects with `ACTION_FAILED` when no tab opens
   * within the timeout, naming the page when a tab was still loading it.
   */
  waitForPopup(trigger: () => Promise<void>, options?: { timeout?: number }): Promise<BrowserTab>;
  /** Opens a blank tab in the same browser context, sharing its cookies and storage, and makes it the active tab. */
  newTab(): Promise<BrowserTab>;
  /** Runs a trigger and waits for its download. */
  waitForDownload(
    trigger: () => Promise<void>,
    options?: { timeout?: number },
  ): Promise<{ path: string; absolutePath: string; suggestedFilename: string }>;
  /** Runs one trigger and waits for the requested number of completed downloads. */
  waitForDownloads(
    trigger: () => Promise<void>,
    options: { count: number; timeout?: number },
  ): Promise<readonly { path: string; absolutePath: string; suggestedFilename: string }[]>;
  /** Viewport-level keyboard, for whatever has focus. */
  readonly keyboard: {
    /** Sends one key. */
    press(key: string): Promise<void>;
    /** Holds one key until up; repeated down calls send a repeat event. */
    down(key: string): Promise<void>;
    /** Releases a held key. */
    up(key: string): Promise<void>;
    /** Types plain text. */
    type(text: string): Promise<void>;
  };
  /** Direct pointer input from test code, independent of agent observations. */
  readonly mouse: {
    /** Moves the pointer. */
    move(x: number, y: number): Promise<void>;
    /** Scrolls the pointer wheel. */
    wheel(deltaX: number, deltaY: number): Promise<void>;
    /** Presses the primary pointer button. */
    down(): Promise<void>;
    /** Releases the primary pointer button. */
    up(): Promise<void>;
  };
}
