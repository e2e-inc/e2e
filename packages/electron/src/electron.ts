/**
 * The `electron` fixture: what a test asks of the Electron app itself rather
 * than of a control in a window. The harness records each call as an
 * `electron.<method>` step bounded by the action timeout.
 */

import { ConfigurationError, isSecret, stepTimeout, type EngineFixtureContext, type FixtureOperation } from '@e2e-dev/core/engine';
import type { Electron, ElectronMainModule, ElectronWindow } from './fixtures.ts';
import { ownedArgument, REFUSED_ENV } from './options.ts';
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
  const button = (options: { readonly button?: 'left' | 'right' | 'middle' } | undefined): 'left' | 'right' | 'middle' => {
    const chosen = options?.button ?? 'left';
    if (chosen !== 'left' && chosen !== 'right' && chosen !== 'middle') throw new ConfigurationError('INVALID_ARGUMENT', "electron.mouse takes { button: 'left' | 'right' | 'middle' }");
    return chosen;
  };
  const text = (value: unknown, method: string): string => {
    if (isSecret(value)) throw new ConfigurationError('POLICY_DENIED', `electron.keyboard.${method} cannot take a secret: fill it into a field with locator.fill`);
    if (typeof value !== 'string') throw new ConfigurationError('INVALID_ARGUMENT', `electron.keyboard.${method} takes a string`);
    return value;
  };
  const electron: Electron = {
    get userDataDir() {
      return surface.dataDirectory();
    },
    async launch(options) {
      const { args = [], env = {}, timeout, ...unknown } = options ?? {};
      const extra = Object.keys(unknown)[0];
      if (extra !== undefined) throw new ConfigurationError('INVALID_ARGUMENT', `electron.launch() takes { args, env, timeout }, not ${extra}`);
      if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) throw new ConfigurationError('INVALID_ARGUMENT', 'electron.launch({ args }) takes a list of strings');
      if (typeof env !== 'object' || env === null || Array.isArray(env) || Object.values(env).some((value) => typeof value !== 'string')) {
        throw new ConfigurationError(holdsSecret(env) ? 'POLICY_DENIED' : 'INVALID_ARGUMENT', 'electron.launch({ env }) takes an object of variable name to string value, and never a secret');
      }
      const owned = args.map(ownedArgument).find((reason) => reason !== undefined);
      if (owned !== undefined) throw new ConfigurationError('INVALID_ARGUMENT', `electron.launch({ args }) ${owned}`);
      const refused = Object.keys(env).find((name) => REFUSED_ENV.has(name.toUpperCase()));
      if (refused !== undefined) throw new ConfigurationError('INVALID_ARGUMENT', `electron.launch({ env }) must not set ${refused}`);
      await surface.launchWith({ args: [...args], env: { ...env } }, context.operation(stepTimeout(timeout, 'electron.launch') ?? context.timeouts.test));
    },
    activeWindow: () => handle(surface.shownWindow()),
    keyboard: {
      press: (key) => surface.pressKey(text(key, 'press'), context.operation()),
      down: (key) => surface.holdKey(text(key, 'down'), 'down', context.operation()),
      up: (key) => surface.holdKey(text(key, 'up'), 'up', context.operation()),
      async type(value, options) {
        const delay = options?.delay ?? 0;
        if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) throw new ConfigurationError('INVALID_ARGUMENT', 'electron.keyboard.type({ delay }) takes a number of milliseconds');
        const typed = text(value, 'type');
        // One budget for the whole text: the action timeout, and the time its delays ask on top.
        await surface.typeKeys(typed, delay, context.operation(context.timeouts.action + [...typed].length * delay));
      },
      insertText: (value) => surface.insertText(text(value, 'insertText'), context.operation()),
    },
    mouse: {
      async move(x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ConfigurationError('INVALID_ARGUMENT', 'electron.mouse.move(x, y) takes two numbers');
        await surface.mouse({ kind: 'move', x, y }, context.operation());
      },
      down: async (options) => surface.mouse({ kind: 'down', button: button(options) }, context.operation()),
      up: async (options) => surface.mouse({ kind: 'up', button: button(options) }, context.operation()),
      async wheel(deltaX, deltaY) {
        if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new ConfigurationError('INVALID_ARGUMENT', 'electron.mouse.wheel(deltaX, deltaY) takes two numbers');
        await surface.mouse({ kind: 'wheel', deltaX, deltaY }, context.operation());
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
  return context.fixture('electron', electron, {
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
