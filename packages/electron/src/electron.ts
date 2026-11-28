/**
 * The `electron` fixture: what a test asks of the Electron app itself rather
 * than of a control in a window. The harness records each call as an
 * `electron.<method>` step bounded by the action timeout.
 */

import { ConfigurationError, isSecret, stepTimeout, TestError, type EngineFixtureContext, type Expectable, type FixtureOperation } from '@e2e-dev/core/engine';
import { EXPECTATION_OPERATIONS, WindowConditions } from './expectation.ts';
import type { Electron, ElectronExpectation, ElectronMainModule, ElectronWindow } from './fixtures.ts';
import { typeKeys } from './actions.ts';
import { hasKey, type MouseButton } from './cdp/input.ts';
import { unsupported } from './errors.ts';
import { checkLaunchOptions } from './options.ts';
import type { ElectronSurface } from './surface.ts';
import type { AppWindow } from './windows.ts';

export function createElectronFixture(surface: ElectronSurface, context: EngineFixtureContext): Electron {
  /** One handle per window, so the same window is the same object for as long as the app runs. */
  const handles = new WeakMap<AppWindow, ElectronWindow>();
  const windowAction: FixtureOperation = { kind: 'resource' };
  const handle = (window: AppWindow): ElectronWindow => {
    const known = handles.get(window);
    if (known !== undefined) return known;
    const made = context.fixture<ElectronWindow>('window', {
      title: () => surface.windowTitle(window, context.operation()),
      url: () => Promise.resolve(window.page.url()),
      isActive: () => surface.isActiveWindow(window),
      isClosed: () => window.page.isClosed(),
      async evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
        if (holdsSecret(arg)) throw new ConfigurationError('POLICY_DENIED', 'window.evaluate cannot take a secret as its argument: fill it into a field with locator.fill');
        return await surface.evaluateInWindow(window, fn, arg as A, context.operation());
      },
      reload: () => surface.reloadWindow(window, context.operation()),
      activate: () => surface.activateWindow(window, context.operation()),
      close: () => surface.closeWindow(window, context.operation()),
    }, { title: windowAction, url: windowAction, activate: windowAction, close: windowAction, evaluate: windowAction, reload: windowAction });
    handles.set(window, made);
    return made;
  };
  const mouseButton = (options: { readonly button?: MouseButton } | undefined): MouseButton => {
    const chosen = options?.button ?? 'left';
    if (chosen !== 'left' && chosen !== 'right' && chosen !== 'middle') throw new TestError('INVALID_ARGUMENT', "electron.mouse takes { button: 'left' | 'right' | 'middle' }");
    return chosen;
  };
  const numbers = (call: string, ...values: readonly unknown[]): void => {
    if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) throw new TestError('INVALID_ARGUMENT', `electron.mouse.${call} takes two numbers`);
  };
  const plainText = (value: unknown, method: string): string => {
    if (isSecret(value)) throw new ConfigurationError('POLICY_DENIED', `electron.keyboard.${method} cannot take a secret: fill it into a field with locator.fill`);
    if (typeof value !== 'string') throw new TestError('INVALID_ARGUMENT', `electron.keyboard.${method} takes a string`);
    return value;
  };
  const holdKey = (direction: 'down' | 'up') => async (key: string): Promise<void> => {
    const name = plainText(key, direction);
    if (!hasKey(name)) throw unsupported(`the keyboard has no key ${JSON.stringify(name)}: name a key such as "Shift" or "Enter", or a character of a US keyboard`);
    await surface.input(`keyboard.${direction}`, (window, budget) => budget.send(() => window.page.keyboard[direction](name)), context.operation());
  };
  const conditions = new WindowConditions(surface, context);
  const electron: Omit<Electron, keyof Expectable<ElectronExpectation>> = {
    waitForURL: (url, options) => conditions.waitForURL(url, options),
    async waitForFunction<R, A>(fn: (arg: A) => R | Promise<R>, arg?: A, options?: { readonly timeout?: number }): Promise<R> {
      if (holdsSecret(arg)) throw new ConfigurationError('POLICY_DENIED', 'electron.waitForFunction cannot take a secret as its argument');
      return await conditions.waitForFunction(fn, arg as A, options);
    },
    get userDataDir() {
      return surface.dataDirectory();
    },
    async launch(options) {
      // A secret would reach the app's command line or environment, where any process can read it.
      if (holdsSecret(options)) throw new ConfigurationError('POLICY_DENIED', 'electron.launch() cannot take a secret in its arguments or variables');
      const extra = checkLaunchOptions(options, surface.root);
      await surface.launchWith(extra, context.operation(stepTimeout(options?.timeout, 'electron.launch') ?? context.timeouts.test));
    },
    activeWindow: () => handle(surface.shownWindow()),
    keyboard: {
      press: async (key) => surface.pressKey(plainText(key, 'press'), context.operation()),
      down: holdKey('down'),
      up: holdKey('up'),
      async type(value, options) {
        const delay = options?.delay ?? 0;
        if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) throw new TestError('INVALID_ARGUMENT', 'electron.keyboard.type({ delay }) takes a number of milliseconds');
        const typed = plainText(value, 'type');
        // One budget for the whole text: the action timeout, and the time its delays ask on top.
        await surface.input('keyboard.type', (window, budget) => typeKeys(window, typed, delay, budget), context.operation(context.timeouts.action + [...typed].length * delay));
      },
      async insertText(value) {
        const inserted = plainText(value, 'insertText');
        await surface.input('keyboard.insertText', (window, budget) => budget.send(() => window.page.keyboard.insertText(inserted)), context.operation());
      },
    },
    mouse: {
      async move(x, y) {
        numbers('move(x, y)', x, y);
        await surface.input('mouse.move', (window, budget) => budget.send(() => window.page.mouse.move(x, y)), context.operation());
      },
      async down(options) {
        const pressed = mouseButton(options);
        await surface.input('mouse.down', (window, budget) => budget.send(() => window.page.mouse.down(pressed)), context.operation());
      },
      async up(options) {
        const released = mouseButton(options);
        await surface.input('mouse.up', (window, budget) => budget.send(() => window.page.mouse.up(released)), context.operation());
      },
      async wheel(deltaX, deltaY) {
        numbers('wheel(deltaX, deltaY)', deltaX, deltaY);
        await surface.input('mouse.wheel', (window, budget) => budget.send(() => window.page.mouse.wheel(deltaX, deltaY)), context.operation());
      },
    },
    async evaluate<R, A>(fn: (electron: ElectronMainModule, arg: A) => R | Promise<R>, arg?: A): Promise<R> {
      // A secret handle would reach the main process as its name and purpose, never its value: refused, as every JSON sink refuses one.
      if (holdsSecret(arg)) throw new ConfigurationError('POLICY_DENIED', 'electron.evaluate cannot take a secret as its argument: resolve the value in the test and pass a string, or keep it out of the main process');
      return await surface.evaluate(fn, arg as A, context.operation());
    },
    windows: () => surface.openWindows().map(handle),
    async waitForWindow(trigger, options) {
      if (typeof trigger !== 'function') throw new ConfigurationError('INVALID_ARGUMENT', 'electron.waitForWindow() takes the function that opens the window');
      return handle(await surface.waitForWindow(trigger, context.operation(stepTimeout(options?.timeout, 'electron.waitForWindow'))));
    },
    async window(which, options) {
      if (typeof which !== 'object' || which === null || (which.title === undefined && which.url === undefined)) {
        throw new ConfigurationError('INVALID_ARGUMENT', 'electron.window() takes { title } or { url }; electron.windows() lists every window');
      }
      return handle(await surface.findWindow(which, context.operation(stepTimeout(options?.timeout, 'electron.window'))));
    },
    async waitForDownload(trigger, options) {
      if (typeof trigger !== 'function') throw new ConfigurationError('INVALID_ARGUMENT', 'electron.waitForDownload() takes the function that starts the download');
      const file = await surface.waitForDownload(trigger, context.operation(stepTimeout(options?.timeout, 'electron.waitForDownload')));
      context.attachArtifact('download', file.path);
      return file;
    },
    // Async so the harness records the registration as an `electron.onDialog` step.
    async onDialog(handler) {
      if (handler !== 'accept' && handler !== 'dismiss' && typeof handler !== 'function') {
        throw new ConfigurationError('INVALID_ARGUMENT', "electron.onDialog() takes 'accept', 'dismiss', or a function that answers the dialog");
      }
      const off = surface.onDialog(handler);
      return () => {
        off();
        return Promise.resolve();
      };
    },
    locator(selector) {
      if (typeof selector !== 'string' || selector.trim() === '') throw new ConfigurationError('INVALID_ARGUMENT', 'electron.locator() takes a CSS selector string');
      return context.locator({ kind: 'selector', selector });
    },
  };
  const input: FixtureOperation = { kind: 'resource' };
  return context.fixture('electron', context.expectable(electron, () => context.fixture('expect', conditions.expectation(), EXPECTATION_OPERATIONS)), {
    waitForURL: { kind: 'resource', timeout: false, verifies: true, label: (url) => String(url) },
    waitForFunction: { kind: 'resource', timeout: false, verifies: true },
    launch: { kind: 'resource', timeout: false },
    keyboard: {
      press: { ...input, label: (key) => String(key) },
      down: { ...input, label: (key) => String(key) },
      up: { ...input, label: (key) => String(key) },
      type: { kind: 'resource', timeout: false, label: (value) => `${typeof value === 'string' ? [...value].length : 0} chars` },
      insertText: { ...input, label: (value) => `${typeof value === 'string' ? [...value].length : 0} chars` },
    },
    mouse: { move: input, down: input, up: input, wheel: input },
    evaluate: { kind: 'resource' },
    waitForWindow: { kind: 'resource', timeout: false },
    window: { kind: 'resource', timeout: (_which, options) => options?.timeout, label: (which) => JSON.stringify({ title: which.title?.toString(), url: which.url?.toString() }) },
    waitForDownload: { kind: 'resource', timeout: false },
    onDialog: { kind: 'resource' },
  });
}

/** Whether a value is a secret handle or holds one in an array or a plain object, at any depth. */
function holdsSecret(value: unknown, seen = new Set<unknown>()): boolean {
  if (isSecret(value)) return true;
  if (typeof value !== 'object' || value === null || seen.has(value)) return false;
  seen.add(value);
  return (Array.isArray(value) ? value : Object.values(value)).some((item) => holdsSecret(item, seen));
}
