/**
 * The browsers the engine drives over WebDriver BiDi, and how each one
 * differs: one `BrowserTraits` record per browser, which the driver reads
 * instead of comparing browser names in its flows.
 */

/** Every browser the engine launches, in the order the CLI lists them. */
export const BROWSER_NAMES = ['chromium', 'firefox'] as const;

export type BrowserName = (typeof BROWSER_NAMES)[number];

/** Whether `name` is a browser the engine launches. */
export function isBrowserName(name: string): name is BrowserName {
  return (BROWSER_NAMES as readonly string[]).includes(name);
}

/** What the driver does differently on one browser. */
export interface BrowserTraits {
  readonly name: BrowserName;
  /**
   * Whether Chromium's DevTools protocol is reachable (the mapper's `goog:cdp`
   * passthrough): keys a BiDi key action cannot carry, drags the page starts,
   * and frames a rotation or 3D transform turns go through it. Only a browser
   * with it is attached to over CDP.
   */
  readonly cdp: boolean;
  /** The `browsingContext.create` type a new top-level context takes. */
  readonly newContext: 'tab' | 'window';
  /** How the attempt's video is recorded: the browser's own BiDi screencast, or the CDP screencast encoded by ffmpeg. */
  readonly screencast: 'bidi' | 'cdp';
  /** Whether `emulation.setMediaFeaturesOverride` takes `prefers-reduced-motion`; without it only the launch preference sets it. */
  readonly emulatesReducedMotion: boolean;
  /**
   * Whether the browser's default answer to a basic-auth challenge is a login
   * prompt BiDi neither reports nor dismisses, which stalls the navigation,
   * so every challenge is held even without credentials.
   */
  readonly promptsForAuth: boolean;
  /** Whether a continued request gets its cookies from the browser's jar, so a header override drops the cookie header it was sent with. */
  readonly continueAddsCookies: boolean;
  /** Whether a continued request keeps its old `content-length` when the route replaces its body, so the driver sets the new one. */
  readonly continueKeepsContentLength: boolean;
  /** Whether `network.continueRequest` can send a request to another URL. */
  readonly continueRewritesUrl: boolean;
  /**
   * Where the body of a held request is read: BiDi's request `collector`, or
   * `cdp`. The Chromium mapper reports a body of bytes as the text of their
   * base64 and sizes a Blob or a form with a file at nothing, so there the
   * body comes from CDP's `Network.getRequestPostData`.
   */
  readonly requestBodies: 'collector' | 'cdp';
  /**
   * Whether a mouse or wheel action first waits for the tab to be shown and
   * its document to have rendered a frame: the parent process hit-tests such
   * input against what the compositor shows.
   */
  readonly pointerWaitsForFrame: boolean;
  /**
   * Whether a tab's window cuts its viewport short: `browsingContext.setViewport`
   * lays the page out at any size and resizes no window, and mouse and wheel
   * input goes through the window, so a point of the page past the window's
   * content area takes none. The window is grown to hold the viewport before
   * the tab gets it (`TabWindows`).
   */
  readonly windowClipsViewport: boolean;
  /**
   * Whether the browser sends a page call again, to the document that
   * replaced the one it was running in. Firefox does for a call it sent to a
   * first, empty document (a new tab's, a frame's), also without
   * `remote.retry-on-abort`, which the driver launches it without. Its
   * refusal of an element then tells nothing of the call: the function may
   * have run in the document that went away.
   */
  readonly resendsPageCalls: boolean;
  /**
   * Whether a page call's `userActivation` is kept as the state of the realm
   * it ran in, not as the call's own. Firefox 159 does that, and takes the
   * document's activation back at the realm's next call without it, so an
   * edit's activation would end with the next read (fixed by Firefox bug
   * 2084107). A call in a sandbox realm of its own activates the document
   * and is never followed by one there.
   */
  readonly activationIsRealmState: boolean;
  /**
   * How a tab's page comes to hold focus whatever window the system shows
   * in front of the browser. `emulated`: each tab is told to behave as
   * focused (CDP `Emulation.setFocusEmulationEnabled`), so every tab of the
   * attempt does at once. `front-tab`: only the tab at the front of the
   * browser does, which a launch preference makes independent of the
   * system's own focus (`focusmanager.testmode`), so a tab that lost the
   * front is brought back to it before keys or text go to it.
   */
  readonly focus: 'emulated' | 'front-tab';
  /**
   * Where a page's console lines, uncaught errors, and the browser's own
   * log lines for it are read. `cdp`: off Chromium's DevTools protocol
   * (`Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`).
   * Its BiDi mapper reports none of the browser's own lines (a failed
   * WebSocket connection), gives an error and a class instance as a bare
   * type, drops a line whose format string and arguments do not pair up,
   * and can exit on one, so its `log.entryAdded` is never subscribed to.
   * `bidi`: off `log.entryAdded`.
   */
  readonly appLog: 'cdp' | 'bidi';
  /** The permission names a target's `app.permissions` may grant. */
  readonly permissions: readonly string[];
}

/** Every browser's traits. */
export const BROWSER_TRAITS: Readonly<Record<BrowserName, BrowserTraits>> = {
  chromium: {
    name: 'chromium',
    cdp: true,
    newContext: 'tab',
    screencast: 'cdp',
    emulatesReducedMotion: true,
    promptsForAuth: false,
    continueAddsCookies: true,
    continueKeepsContentLength: false,
    continueRewritesUrl: true,
    requestBodies: 'cdp',
    pointerWaitsForFrame: false,
    windowClipsViewport: false,
    resendsPageCalls: false,
    activationIsRealmState: false,
    focus: 'emulated',
    appLog: 'cdp',
    permissions: [
      'accelerometer', 'ambient-light-sensor', 'background-sync', 'camera', 'clipboard-read', 'clipboard-write',
      'geolocation', 'gyroscope', 'local-fonts', 'local-network-access', 'magnetometer', 'microphone', 'midi',
      'midi-sysex', 'notifications', 'payment-handler', 'screen-wake-lock', 'storage-access',
    ],
  },
  firefox: {
    name: 'firefox',
    cdp: false,
    newContext: 'window',
    screencast: 'bidi',
    emulatesReducedMotion: false,
    promptsForAuth: true,
    continueAddsCookies: false,
    continueKeepsContentLength: true,
    continueRewritesUrl: false,
    requestBodies: 'collector',
    pointerWaitsForFrame: true,
    windowClipsViewport: true,
    resendsPageCalls: true,
    activationIsRealmState: true,
    focus: 'front-tab',
    appLog: 'bidi',
    permissions: ['geolocation', 'local-network-access', 'notifications', 'persistent-storage', 'push', 'screen-wake-lock'],
  },
};
