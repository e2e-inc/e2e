/**
 * The `browser` fixture over the driver's surface: each method's step
 * declaration, the matchers (`expectation.ts`), the route contract
 * (`routes.ts`), and the argument checks (`arguments.ts`). Every async
 * method runs as a harness-recorded `browser.<method>` step;
 * `expect(browser)` reaches the matchers attached through
 * `context.expectable`.
 *
 * Each method binds one driver call through the surface's `guard`, as
 * `engine.ts` binds the contract hooks: the label, the call, and how the
 * guard treats it.
 *
 * Layering rule: validation (`resolveUrl`, JSON checks, cookie URLs) runs
 * outside the guard, so a runner error keeps its classification and only
 * driver faults are translated. The URL rule is never re-implemented here:
 * `context.app.resolveUrl` is the one place that says which URLs a test may
 * open.
 */

import path from 'node:path';
import type { Expectable, JsonValue } from '@e2e-dev/core';
import {
  Deadline,
  rejectUnknownOptions,
  stepTimeout,
  TestError,
  toTextPattern,
  type EngineFixtureContext,
  type FixtureOperation,
  type FixtureOperations,
  type LocatorExpression,
} from '@e2e-dev/core/engine';
import { invalidState } from '../errors.ts';
import { createBrowserExpectation } from './expectation.ts';
import type { Browser, BrowserExpectation, BrowserTab, FrameScreen } from './types.ts';
import { initScriptLabel, testInitScriptSource } from '../init-scripts.ts';
import { mediaLabel } from '../options.ts';
import { evaluateInPage } from '../in-page/evaluation.ts';
import { documentTitle } from '../in-page/document.ts';
import { routePatternMatches, routePatternsEqual } from '../driver/route-pattern.ts';
import { cookieTargets, requireCookieFilter, requireDownloadCount, requireMedia, requireWaitUntil } from './arguments.ts';
import { typeInto } from '../driver/actions.ts';
import type { OperationBudget } from '../driver/budget.ts';
import { deleteCookies, readCookies, writeCookies } from '../driver/cookies.ts';
import type { SavedDownload } from '../driver/downloads.ts';
import { moveSources, pressDownSources, releaseSources, wheelSources } from '../driver/input-sources.ts';
import { fixtureKeyStroke } from '../driver/keyboard.ts';
import { readResponseBody, runRouteHandler, waitedResponse } from './routes.ts';
import type { BidiSession } from '../driver/session.ts';
import { goto, reload, traverse } from '../driver/steering.ts';
import type { BidiSurface, GuardKind } from '../driver/surface.ts';
import type { PageArgument } from '../driver/script.ts';
import type { AttemptTab } from '../driver/tabs.ts';

/** Builds the attempt's `browser` fixture over the driver's surface. */
export function createBrowserFixture(surface: BidiSurface, context: EngineFixtureContext): Browser {
  /** The attempt the fixture is built for: its latch, dialogs, and tabs are this attempt's, so a route handler that outlives it fails only its own. */
  const attempt = surface.attempt();
  /** Refuses a call that runs outside the guard once the attempt ended, as the guard refuses a step. */
  const requireRunning = (): void => {
    if (attempt.lifetime.aborted) throw invalidState('no attempt is running');
  };
  /** The absolute path of a file a test names relative to the project root. */
  const projectPath = (file: string): string => path.resolve(attempt.settings.projectRoot, file);
  /** Runs one driver call under the surface's guard, within the action timeout. */
  const run = <T>(label: string, work: (session: BidiSession, budget: OperationBudget) => Promise<T>, kind?: GuardKind): Promise<T> =>
    surface.guard(context.operation(), label, work, kind);
  /** Runs one navigation within the call's own timeout, else the test's, and shows the trace the screen it left. */
  const navigate = (api: string, options: { timeout?: number } | undefined, work: (session: BidiSession, budget: OperationBudget) => Promise<void>): Promise<void> =>
    surface.guard(context.operation(stepTimeout(options?.timeout, api) ?? context.timeouts.test), 'navigation', work, { traced: true });
  const currentUrl = (deadline?: Deadline): Promise<string> => surface.guard(context.operation(deadline?.remaining()), 'url', (session) => session.currentUrl());
  const currentTitle = (deadline?: Deadline): Promise<string> => surface.guard(context.operation(deadline?.remaining()), 'title', (session) => session.page.run(documentTitle, []));
  const expectation = createBrowserExpectation({
    currentUrl,
    currentTitle,
    context,
  });
  /** One handle per tab, so the same tab is the same object for the attempt. */
  const tabHandles = new WeakMap<AttemptTab, BrowserTab>();
  const tabAction: FixtureOperation = { kind: 'resource' };
  /** The handle a test holds for one of the attempt's tabs. */
  const tabHandle = (tab: AttemptTab): BrowserTab => {
    const known = tabHandles.get(tab);
    if (known !== undefined) return known;
    const handle = context.fixture<BrowserTab>('tab', {
      url: () => run('url', (session) => session.currentUrl(tab.context)),
      title: () => run('title', (session) => session.page.run(documentTitle, [], tab.context)),
      isActive: () => !attempt.lifetime.aborted && attempt.tabs.active() === tab,
      isClosed: () => tab.closed,
      activate: () => run('tab', (session) => session.tabs.show(tab)),
      close: () => run('tab', (session) => session.tabs.close(tab)),
    }, { url: tabAction, title: tabAction, activate: tabAction, close: tabAction });
    tabHandles.set(tab, handle);
    return handle;
  };

  const browser: Omit<Browser, keyof Expectable<BrowserExpectation>> = {
    goto(url, options) {
      const resolved = context.app.resolveUrl(url);
      const waitUntil = requireWaitUntil(options);
      return navigate('browser.goto', options, (session, { signal }) => goto(session, resolved, waitUntil, signal));
    },
    reload: (options) => navigate('browser.reload', options, (session, { signal }) => reload(session, signal)),
    back: (options) => navigate('browser.back', options, (session, { timeoutMs, signal }) => traverse(session, -1, timeoutMs, signal)),
    forward: (options) => navigate('browser.forward', options, (session, { timeoutMs, signal }) => traverse(session, 1, timeoutMs, signal)),
    url: () => currentUrl(),
    title: () => currentTitle(),
    waitForURL: (url, options) => {
      rejectUnknownOptions('browser.waitForURL', options, ['timeout']);
      return expectation.toHaveURL(url, options);
    },
    locator: (selector) => context.locator({ kind: 'selector', selector: requireSelector('browser.locator', selector) }),
    frameLocator: (selector) => frameScreen(context, [requireSelector('browser.frameLocator', selector)]),
    evaluate<T extends JsonValue>(fn: string | ((arg?: never) => T | Promise<T>), arg?: JsonValue): Promise<T> {
      return evaluateInPage(fn, arg, (evaluate, input) => run('evaluate', (session) => session.evaluate(evaluate.toString(), input as PageArgument | undefined), { testCode: true }));
    },
    async addInitScript(script: unknown, ...rest: unknown[]) {
      const source = await testInitScriptSource(script, rest.length === 0 ? undefined : { arg: rest[0] }, projectPath);
      await run('addInitScript', (session) => session.userContext.addInitScript(source));
    },
    route(pattern, handler) {
      const wirePattern = toTextPattern(pattern);
      return run('route', (session) => session.network.addRoute({
        pattern: wirePattern,
        handle: (request, decisions) => {
          const work = runRouteHandler(
            handler,
            { url: request.url, method: request.method, headers: request.headers, ...(request.postData === undefined ? {} : { postData: request.postData }) },
            decisions,
            (error) => attempt.latch.latch(error),
            context,
            projectPath,
          );
          attempt.latch.track('route', work);
          return work;
        },
      }));
    },
    unroute(pattern) {
      const wirePattern = toTextPattern(pattern);
      return run('unroute', async (session) => session.network.removeRoutes((route) => routePatternsEqual(route.pattern, wirePattern)));
    },
    unrouteAll: () => run('unroute', async (session) => session.network.removeRoutes(() => true)),
    async waitForResponse(pattern, options) {
      const wirePattern = toTextPattern(pattern);
      const response = await surface.guard(
        context.operation(stepTimeout(options?.timeout, 'browser.waitForResponse')),
        'waitForResponse',
        (session, { signal }) => session.network.waitForResponse((url) => routePatternMatches(wirePattern, url), signal),
      );
      return waitedResponse(context, response, readResponseBody('waitForResponse', () => response.body()));
    },
    cookies: () => run('cookies', readCookies),
    setCookies(cookies) {
      const targets = cookieTargets(cookies, context);
      return run('setCookies', (session) => writeCookies(session, targets));
    },
    async clearCookies(options) {
      requireCookieFilter(options);
      return run('clearCookies', (session) => deleteCookies(session, options));
    },
    setViewport: async (size) => {
      await run('setViewport', (session) => session.setViewport(size));
      context.attachViewport({ width: size.width, height: size.height, scale: 1 });
    },
    emulateMedia(media) {
      const requested = requireMedia(media);
      return run('emulateMedia', (session) => session.userContext.emulateMedia(requested));
    },
    // Async so the harness records the registration as a `browser.onDialog` step.
    async onDialog(handler) {
      requireRunning();
      const unsubscribe = attempt.dialogs.add(handler);
      return async () => unsubscribe();
    },
    tabs: () => {
      requireRunning();
      attempt.latch.throwPending();
      return attempt.tabs.list().map(tabHandle);
    },
    async waitForPopup(trigger, options) {
      rejectUnknownOptions('browser.waitForPopup', options, ['timeout']);
      const operation = context.operation(stepTimeout(options?.timeout, 'browser.waitForPopup'));
      return tabHandle(await surface.guard(operation, 'browser.waitForPopup', (session, budget) => session.tabs.waitForPopup(trigger, budget), { trigger: true }));
    },
    newTab: async () => tabHandle(await run('tab', (session) => session.newTab())),
    async waitForDownload(trigger, options) {
      const [file] = await downloads(surface, context, trigger, 1, options?.timeout, 'browser.waitForDownload');
      return file!;
    },
    waitForDownloads: (trigger, options) => downloads(surface, context, trigger, requireDownloadCount(options), options.timeout, 'browser.waitForDownloads'),
    keyboard: {
      down: (key) => run('keyboard.down', (session, { signal }) => session.input.key(fixtureKeyStroke(key, 'keyDown'), signal), { input: true }),
      up: (key) => run('keyboard.up', (session, { signal }) => session.input.key(fixtureKeyStroke(key, 'keyUp'), signal), { input: true }),
      press: (key) => run('keyboard.press', (session, { signal }) => session.input.key(fixtureKeyStroke(key, 'press'), signal), { input: true }),
      type: (text) => run('keyboard.type', (session, { signal }) => typeInto(session, text, signal), { input: true }),
    },
    mouse: {
      move: (x, y) => run('mouse.move', (session, { signal }) => session.input.send(moveSources(Math.round(x), Math.round(y)), signal), { input: true }),
      wheel: (deltaX, deltaY) => run('mouse.wheel', (session, { signal }) => session.input.send(wheelSources(session.input.pointer.x, session.input.pointer.y, deltaX, deltaY), signal), { input: true }),
      down: () => run('mouse.down', (session, { signal }) => session.input.send(pressDownSources(session.input.pointer.x, session.input.pointer.y), signal), { input: true }),
      up: () => run('mouse.up', (session, { signal }) => session.input.send(releaseSources(), signal), { input: true }),
    },
  };
  return declareFixture(context, browser, expectation);
}

/**
 * Declares a built `browser` object as the fixture: each method's step kind,
 * label, and timeout, and `expect(browser)` wired to `expectation`.
 */
function declareFixture(
  context: EngineFixtureContext,
  browser: Omit<Browser, keyof Expectable<BrowserExpectation>>,
  expectation: BrowserExpectation,
): Browser {
  const action: FixtureOperation = { kind: 'resource' };
  const navigationCall = { kind: 'resource', timeout: false } as const;
  const matchers: FixtureOperations<BrowserExpectation> = {
    toHaveURL: { kind: 'assertion', timeout: false, label: (expected) => String(expected) },
    toHaveTitle: { kind: 'assertion', timeout: false, label: (expected) => String(expected) },
    toHaveClass: { kind: 'assertion', timeout: false, label: (_target, expected) => String(expected) },
    get not() { return matchers; },
  };
  return context.fixture('browser', context.expectable(browser, () => context.fixture('expect', expectation, matchers)), {
    goto: { ...navigationCall, label: (url) => url },
    reload: navigationCall,
    back: navigationCall,
    forward: navigationCall,
    url: action,
    title: action,
    waitForURL: { ...navigationCall, verifies: true, label: patternLabel },
    evaluate: action,
    addInitScript: { ...action, label: (script) => initScriptLabel(script) },
    route: { ...action, label: patternLabel },
    unroute: { ...action, label: patternLabel },
    unrouteAll: action,
    waitForResponse: { ...action, timeout: (_pattern, options) => options?.timeout, label: patternLabel },
    cookies: action,
    setCookies: action,
    clearCookies: action,
    setViewport: action,
    emulateMedia: { ...action, label: (media) => mediaLabel(media) },
    onDialog: action,
    waitForPopup: { ...action, timeout: false },
    newTab: action,
    waitForDownload: { ...action, timeout: false },
    waitForDownloads: { ...action, timeout: false },
    keyboard: { down: { ...action, label: (key) => key }, up: { ...action, label: (key) => key }, press: { ...action, label: (key) => key }, type: { ...action, label: (text) => `${text.length} chars` } },
    mouse: { move: action, wheel: action, down: action, up: action },
  });
}

/** Runs `trigger` once and saves the first `count` downloads it starts, each attached as a `download` artifact. */
async function downloads(
  surface: BidiSurface,
  context: EngineFixtureContext,
  trigger: () => Promise<void>,
  count: number,
  timeout: number | undefined,
  api: string,
): Promise<SavedDownload[]> {
  const files = await surface.guard(context.operation(stepTimeout(timeout, api)), 'download', (session, budget) => session.downloads.save(count, trigger, budget), { trigger: true });
  for (const file of files) context.attachArtifact('download', file.path);
  return files;
}

/** The selector a locator method was given, refused unless it is a nonempty string. */
function requireSelector(method: string, selector: unknown): string {
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new TestError('INVALID_LOCATOR', `${method}() requires a nonempty selector`);
  }
  return selector;
}

/** A URL pattern as steps and errors name it: a string quoted, a RegExp as its literal. */
function patternLabel(pattern: string | RegExp): string {
  return typeof pattern === 'string' ? JSON.stringify(pattern) : String(pattern);
}

/**
 * The scope for the innermost of `frames` (outermost first). Every query and
 * both escape hatches compile through the same `frame` chain, so a `locator`
 * inside it resolves against the innermost document.
 */
function frameScreen(context: EngineFixtureContext, frames: readonly string[]): FrameScreen {
  const scope = (expression: LocatorExpression): LocatorExpression =>
    frames.reduceRight<LocatorExpression>((source, selector) => ({ kind: 'frame', selector, source }), expression);
  return Object.assign(context.screen(scope), {
    locator: (selector: string) =>
      context.locator(scope({ kind: 'selector', selector: requireSelector('locator', selector) })),
    frameLocator: (selector: string) =>
      frameScreen(context, [...frames, requireSelector('frameLocator', selector)]),
  });
}
