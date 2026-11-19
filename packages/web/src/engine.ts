/**
 * The web engine for e2e: a browser driven over WebDriver BiDi, built with
 * the public `defineEngine`, validated by the same rules and graded by the
 * same capabilities as any other engine. Core imports nothing from here; this
 * package imports the contract from `@e2e-dev/core/engine` and contributes the `browser`
 * fixture the way a device engine contributes `device`.
 */

import {
  ConfigurationError,
  defineEngine,
  isSecret,
  obj,
  LOCATOR_ACTION_KINDS,
  POINTER_ACTION_KINDS,
  validateComputedStyleProperties,
  type EngineHandle,
} from '@e2e-dev/core/engine';
import { createRequire } from 'node:module';
import { LeasedBrowsers } from './provider.ts';
import { DEFAULT_VIEWPORT, type WebOptions } from './options.ts';
import { perform, performAt, typeText } from './driver/actions.ts';
import { screenshot } from './driver/artifacts.ts';
import { locate, observe, readStyle } from './driver/observe.ts';
import { captureState, restoreState } from './driver/state.ts';
import { goto, reset, traverse } from './driver/steering.ts';
import { BidiSurface } from './driver/surface.ts';
import { attachSource, connectSource, launchSource, leaseSource, type BrowserSource } from './driver/browser-source.ts';
import type { WebFixtures } from './fixtures.ts';
import { createBrowserFixture } from './fixture/browser.ts';
import { ConfiguredInitScripts } from './init-scripts.ts';
import { checkWebOptions, validateApp } from './validate-options.ts';

export function web(options: WebOptions = {}): EngineHandle<WebFixtures> {
  return createWeb(options);
}

/**
 * The web engine `attachBrowser` drives the Chromium at `cdpEndpoint` with:
 * its attempt drives the tab already open in the browser's own user context
 * and leaves both behind, so the target needs no `app.url`.
 */
export function attachedWeb(cdpEndpoint: string, options: WebOptions): EngineHandle<WebFixtures> {
  return createWeb(options, attachSource(cdpEndpoint));
}

/**
 * The web engine for `options`, its browser from `attachTo` when given, and
 * otherwise from what `options` name. A source whose attempt adopts the page
 * the browser shows serves one worker: one endpoint shows one page. Not
 * exported: a project that installs the package compiles this module's
 * declarations, and a driver type in an exported signature would bring the
 * whole driver's into them.
 */
function createWeb(options: WebOptions, attachTo?: BrowserSource): EngineHandle<WebFixtures> {
  const { browser, provider, connect } = checkWebOptions(options);
  const media = obj({ colorScheme: options.colorScheme, reducedMotion: options.reducedMotion });
  const source = attachTo
    ?? (provider !== undefined ? leaseSource(new LeasedBrowsers(provider)) : connect !== undefined ? connectSource(connect.cdpEndpoint, connect.context) : launchSource(browser, media));
  // Clearing state and saved sessions replace the user context, which only an attempt in a fresh one may do; any other says why not.
  const { userContext } = source;
  const surface = new BidiSurface({
    viewport: options.viewport === undefined ? DEFAULT_VIEWPORT : options.viewport,
    testIdAttribute: options.testIdAttribute ?? 'data-testid',
    initScripts: new ConfiguredInitScripts(options.initScripts ?? []),
    screencast: options.screencast ?? {},
    headers: options.headers,
    basicAuth: options.basicAuth,
    credentialOrigins: options.credentialOrigins,
    userAgent: options.userAgent,
    locale: options.locale,
    timezoneId: options.timezoneId,
    media,
    source,
  });
  return defineEngine<WebFixtures>({
    name: 'web',
    version: ownVersion(),
    spiVersion: 1,
    platform: 'web',
    ...(userContext.mode === 'adopt-tab' ? { workers: 1 } : {}),
    prepare: (info) => surface.prepare(info),
    finish: (info) => surface.finish(info),
    doctor: (info) => surface.doctor(info),
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    settleAttempt: (context) => surface.settleAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    // A snapshot names the tabs when more than one is open; a tab that closes under a read makes it stale.
    observe: (operation, observeOptions) =>
      surface.guard(operation, 'observe', (session, { timeoutMs, signal }) => session.readTab(async (tab) => {
        const snapshot = await observe(session, timeoutMs, signal, observeOptions);
        const tabs = session.tabs.describe(tab);
        return tabs === undefined ? snapshot : { ...snapshot, tabs };
      })),
    readStyle: (ref, properties, operation) =>
      surface.guard(operation, 'read computed style', (session) => readStyle(session, ref, validateComputedStyleProperties(properties))),
    locate: (expression, operation) => surface.guard(operation, 'locate', (session) => session.readTab(() => locate(session, expression))),
    // An input operation that fails once its input went out may have reached the app; a sensitive value never leaves in its error.
    perform: (ref, action, operation) =>
      surface.guard(operation, action.kind, (session, { timeoutMs, signal }) => perform(session, ref, action, timeoutMs, signal), {
        input: true,
        traced: true,
        ...(action.kind === 'fill' && action.sensitive ? { sensitive: action.value } : {}),
      }),
    // A browser honors every action kind of the contract.
    actions: LOCATOR_ACTION_KINDS,
    // The click holds each modifier.
    tapModifiers: true,
    // A page takes every pointer action of the contract at a bare point too.
    performAt: (point, action, operation) =>
      surface.guard(operation, `${action.kind} at point`, (session, { signal }) => performAt(session, point, action, signal), { input: true, traced: true }),
    pointerActions: POINTER_ACTION_KINDS,
    keyboard: {
      type: (text, keyboardOptions, operation) =>
        surface.guard(operation, 'keyboard.type', (session, { signal }) => typeText(session, text, keyboardOptions.replace, signal), { input: true, traced: true }),
      press: (key, operation) => surface.guard(operation, 'keyboard.press', (session, { signal }) => session.input.press(key, signal), { input: true, traced: true }),
    },
    validateApp: (app, info) => validateApp(app, info, browser, attachTo === undefined),
    ...(isSecret(options.basicAuth?.password) ? { secrets: [options.basicAuth.password] } : {}),
    session: {
      open: (url, operation) => surface.guard(operation, 'navigation', (session, { signal }) => goto(session, url, 'load', signal), { traced: true }),
      back: (operation) => surface.guard(operation, 'navigation', (session, { timeoutMs, signal }) => traverse(session, -1, timeoutMs, signal), { traced: true }),
      // The agent's `resize` verb sets the viewport as `browser.setViewport` does, and shows the screen after it.
      resize: (size, operation) => surface.guard(operation, 'resize', (session) => session.setViewport(size), { traced: true }),
      // The agent's `switch_tab` and `close_tab` verbs, by place in opening order, each showing the screen after it.
      switchTab: (index, operation) => surface.guard(operation, 'switch tab', (session) => session.tabs.showAt(index), { traced: true }),
      closeTab: (index, operation) => surface.guard(operation, 'close tab', (session) => session.tabs.closeAt(index), { traced: true }),
      // Replaces the tab with a blank one, keeping the attempt's storage.
      restart: (operation) => surface.guard(operation, 'restart', (session, { signal }) => session.replaceTabs(signal)),
      // Starts the attempt over in a clean user context.
      reset: userContext.mode === 'fresh'
        ? (operation) => surface.guard(operation, 'state reset', (session, { signal }) => reset(session, signal))
        : () => Promise.reject(new ConfigurationError('UNSUPPORTED_CAPABILITY', userContext.limit('app.clearState()'))),
    },
    artifacts: {
      screenshot: (label, operation) => surface.guard(operation, 'screenshot', (session, { signal }) => screenshot(session, label, signal)),
      // The provider's recording when it records, else the driver's own.
      startVideo: (operation) => surface.guard(operation, 'video', (session, { signal }) => session.video.start(signal)),
      stopVideo: (operation) => surface.guard(operation, 'video', (session, { signal }) => session.video.stop(signal)),
    },
    ...(userContext.mode === 'fresh'
      ? {
          state: {
            capture: (operation) => surface.guard(operation, 'state capture', (session) => captureState(session)),
            restore: (state, operation) => surface.guard(operation, 'state restore', (session, { signal }) => restoreState(session, state, signal)),
          },
        }
      : {}),
    fixtures: {
      browser: (context) => createBrowserFixture(surface, context),
    },
  });
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
