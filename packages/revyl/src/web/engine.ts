/**
 * `revylWeb()`: an e2e engine that drives a Revyl hosted web session (Chrome
 * in Revyl's cloud) through Revyl's HTTP API instead of CDP. Each worker
 * starts one session; `observe` and `locate` read the page's Maestro web
 * hierarchy, and actions go through Revyl's device proxy at the centre of the
 * node they target.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  ConfigurationError,
  EngineError,
  TestError,
  defineEngine,
  parseKey,
  rejectUnknownKeys,
  resolveExpression,
  type EngineAppCheckInfo,
  type EngineAppDeclaration,
  type EngineHandle,
  type EngineSnapshot,
  type LocatorAction,
  type LocatorActionKind,
  type NodeRef,
  type OperationContext,
  type PointerAction,
  type PointerActionKind,
  type SelectOption,
  type SemanticNode,
  type ViewportPoint,
  type ViewportSize,
} from '@e2e-dev/core/engine';
import { revylCredentials } from '../credentials.ts';
import { RevylHttpError, RevylWebClient, type StartedSession, type WebViewport } from './client.ts';
import {
  OBSERVED_MARKS,
  ROOT_ID,
  flatten,
  markSelector,
  marksFor,
  matchElements,
  project,
  isVolatile,
  labelShownMarks,
  sameAttributes,
  secureNodes,
  type Mark,
  type MaestroNode,
} from './tree.ts';

export interface RevylWebOptions {
  /** Id of the Revyl Web app the sessions run under (`revyl app list --platform web`). */
  readonly app: string;
  /**
   * Page each session opens before the first test, registered as a URL build
   * of `app`. It must load without an error. Absent, the origin of the
   * target's `app.url`.
   */
  readonly startUrl?: string | undefined;
  /** CSS viewport, 1280 by 800 when absent. */
  readonly viewport?: WebViewport | undefined;
  /** Seconds without a command before Revyl ends the session; 600 when absent. */
  readonly idleTimeoutSeconds?: number | undefined;
  /** Attribute `getByTestId` reads; `data-testid` when absent. */
  readonly testIdAttribute?: string | undefined;
}

const OPTION_KEYS: readonly string[] = Object.keys({
  app: true,
  startUrl: true,
  viewport: true,
  idleTimeoutSeconds: true,
  testIdAttribute: true,
} satisfies Record<keyof RevylWebOptions, true>);

const ACTIONS: readonly LocatorActionKind[] = ['tap', 'doubleTap', 'secondaryTap', 'longPress', 'fill', 'clear', 'press', 'hover', 'selectOption', 'swipe', 'scrollIntoView', 'dragTo'];
const POINTER_ACTIONS: readonly PointerActionKind[] = ['tap', 'doubleTap', 'secondaryTap', 'hover', 'longPress', 'dragTo'];
const MODIFIERS: Readonly<Record<string, string>> = { Shift: 'shift', Control: 'ctrl', Alt: 'alt', Meta: 'meta', ControlOrMeta: 'ctrl' };
const NAMED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const VERSION = ownVersion();

/** One Revyl web session per worker, driven as `platform: 'web'`. */
export function revylWeb(options: RevylWebOptions): EngineHandle {
  rejectUnknownKeys('revylWeb()', options, OPTION_KEYS);
  if (typeof options.app !== 'string' || options.app.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'revylWeb: `app` is required, as the id of a Revyl Web app');
  }
  if (options.startUrl !== undefined && !isHttpUrl(options.startUrl)) {
    throw new ConfigurationError('INVALID_CONFIG', 'revylWeb: `startUrl` must be an http(s) URL Revyl can reach');
  }
  const viewport = options.viewport ?? { width: 1280, height: 800 };
  if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) || viewport.width < 320 || viewport.width > 3840 || viewport.height < 240 || viewport.height > 2160) {
    throw new ConfigurationError('INVALID_CONFIG', 'revylWeb: `viewport` must be whole CSS pixels, width 320 to 3840 and height 240 to 2160');
  }
  const surface = new RevylWebSurface(options.app.trim(), options.startUrl, viewport, options.idleTimeoutSeconds ?? 600, options.testIdAttribute ?? 'data-testid');
  return defineEngine({
    name: 'revyl-web',
    version: VERSION,
    spiVersion: 1,
    platform: 'web',
    validateApp,
    init: (info) => surface.init(info.env, info.app.origin, info.signal, info.log),
    dispose: (context) => surface.dispose(context.signal),
    startAttempt: async (context) => {
      surface.artifactsDir = context.artifactsDir;
      context.environment({ browser: 'Chrome (Revyl)' });
      await surface.startAttempt(context.signal);
    },
    observe: (context, observeOptions) => surface.observe(context, observeOptions?.pixels === true),
    locate: (expression, context) => surface.locate(expression, context),
    perform: (ref, action, context) => surface.perform(ref, action, context),
    actions: ACTIONS,
    performAt: (point, action, context) => surface.performAt(point, action, context),
    pointerActions: POINTER_ACTIONS,
    tapModifiers: true,
    session: {
      open: (url, context) => surface.act('navigate', { url }, context),
      back: (context) => surface.act('back', undefined, context),
      resize: (size, context) => surface.resize(size, context),
      restart: (context) => surface.act('reload', undefined, context),
      // No `reset`: Revyl's clear_state ends the web session, so app.clearState()
      // is refused as unsupported rather than sent.
      switchTab: (index, context) => surface.tab('tab_switch', index, context),
      closeTab: (index, context) => surface.tab('tab_close', index, context),
    },
    artifacts: {
      screenshot: (label, context) => surface.screenshot(label, context),
    },
    // One browser serves every attempt of a worker, as one device does on mobile.
    isolation: 'worker',
  });
}

function validateApp(app: EngineAppDeclaration, { targetName }: EngineAppCheckInfo): void {
  if (app.url === undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `target "${targetName}" needs app.url: revylWeb opens a website`);
  }
  if (app.bundleId !== undefined || app.appPath !== undefined || app.launchArguments !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `target "${targetName}" declares a device app; revylWeb opens app.url in a browser`);
  }
  if (app.permissions !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `target "${targetName}" declares app.permissions; revylWeb cannot grant browser permissions`);
  }
}

class RevylWebSurface {
  artifactsDir: string | undefined;
  #client: RevylWebClient | undefined;
  #session: StartedSession | undefined;
  /** The id of a session `init` asked Revyl for, kept until `dispose` so a start cut off midway is still stopped. */
  #requested: string | undefined;
  /** The viewport the options ask for; each attempt starts at it. */
  readonly #configured: ViewportSize;
  #viewport: ViewportSize;
  /** Image pixels per CSS pixel of the session's screenshots. */
  #scale = 1;
  /** Each node handed out, as the hierarchy described it then. */
  readonly #minted = new Map<string, Minted>();
  /** Where each off-screen node was when it was last scrolled toward, so a scroll that moved nothing is not tried again. */
  readonly #scrolledFrom = new Map<string, string>();
  /** CSS query answers for one hierarchy, until it changes or an action runs. */
  #answers: { readonly hierarchy: string; readonly bySelector: Map<string, readonly MaestroNode[]> } | undefined;
  #screenshots = 0;

  constructor(
    readonly app: string,
    readonly startUrl: string | undefined,
    viewport: WebViewport,
    readonly idleTimeoutSeconds: number,
    readonly testIdAttribute: string,
  ) {
    this.#configured = viewport;
    this.#viewport = viewport;
  }

  async init(env: Readonly<Record<string, string | undefined>>, origin: string | undefined, signal: AbortSignal, log: (line: string) => void): Promise<void> {
    const startUrl = this.startUrl ?? origin;
    if (startUrl === undefined) throw new Error('revylWeb: the target has no app URL to start the session on; set `startUrl`');
    const client = new RevylWebClient(revylCredentials(env), VERSION);
    this.#client = client;
    const buildId = await client.registerUrlBuild(this.app, startUrl, signal);
    const sessionId = crypto.randomUUID();
    this.#requested = sessionId;
    const session = await client.startSession(
      { sessionId, appId: this.app, buildId, viewport: { width: this.#configured.width, height: this.#configured.height }, idleTimeoutSeconds: this.idleTimeoutSeconds },
      signal,
    );
    this.#session = session;
    log(`Revyl web session started: ${session.viewerUrl}`);
    await this.#readGeometry(signal);
  }

  /** Stops the session `init` asked for, whether or not its start finished. */
  async dispose(signal: AbortSignal): Promise<void> {
    const sessionId = this.#requested;
    this.#requested = undefined;
    this.#session = undefined;
    this.#minted.clear();
    if (sessionId === undefined) return;
    try {
      await this.#client?.stopSession(sessionId, signal);
    } catch (error) {
      // A start cut off before Revyl made the session leaves none to stop
      // (404), and one Revyl already ended answers 409.
      if (!(error instanceof RevylHttpError && (error.status === 404 || error.status === 409))) throw error;
    }
  }

  /**
   * Puts the session back where an attempt starts, since it outlives the
   * attempt: one tab, the first, and the configured viewport.
   */
  async startAttempt(signal: AbortSignal): Promise<void> {
    this.#answers = undefined;
    this.#scrolledFrom.clear();
    await this.#closeExtraTabs(signal);
    if (this.#viewport.width !== this.#configured.width || this.#viewport.height !== this.#configured.height) {
      await this.#act('viewport', { width: this.#configured.width, height: this.#configured.height }, signal);
      await this.#readGeometry(signal);
    }
  }

  observe(context: OperationContext, pixels: boolean): Promise<EngineSnapshot> {
    return withDeadline(context, 'observe', async (signal) => {
      const [[tree, matched], tabs, screenshot] = await Promise.all([
        this.#read(OBSERVED_MARKS, signal),
        this.#bound.client.tabs(this.#bound.run, signal),
        pixels ? this.#bound.client.screenshot(this.#bound.run, signal) : undefined,
      ]);
      const root = this.#project(tree, matched, true);
      const activeIndex = tabs.findIndex((tab) => tab.active);
      const active = tabs[activeIndex];
      return {
        ...(active === undefined ? {} : { location: `${active.url_origin}${active.url_path ?? active.route_pattern}` }),
        root,
        viewport: this.#viewport,
        ...(tabs.length > 1 && activeIndex >= 0 ? { tabs: { count: tabs.length, active: activeIndex } } : {}),
        ...(screenshot === undefined ? {} : { pixels: this.#pixels(screenshot) }),
      };
    });
  }

  locate(expression: Parameters<typeof resolveExpression>[0], context: OperationContext): Promise<readonly SemanticNode[]> {
    return withDeadline(context, 'locate', async (signal) => {
      const marks = marksFor(expression, this.testIdAttribute);
      const [tree, matched] = await this.#read(marks, signal);
      const root = this.#project(tree, matched, false);
      const selected = new Map(matched.flatMap(([mark, matches]) => (mark.kind === 'selector' ? [[mark.selector, matches] as const] : [])));
      const elements = flatten(tree);
      return resolveExpression(expression, root.children ?? [], {
        selector: (selector, candidates) => {
          const ids = matchElements(elements, selected.get(selector) ?? []);
          return candidates.filter((node) => ids.has(node.ref.id));
        },
      });
    });
  }

  perform(ref: NodeRef, action: LocatorAction, context: OperationContext): Promise<void> {
    return withDeadline(context, action.kind, (signal) => this.#perform(ref, action, signal));
  }

  performAt(point: ViewportPoint, action: PointerAction, context: OperationContext): Promise<void> {
    return withDeadline(context, action.kind, (signal) => this.#performAt(point, action, signal));
  }

  /** One session action under the operation's deadline. */
  act(action: string, body: object | undefined, context: OperationContext): Promise<void> {
    return withDeadline(context, action, (signal) => this.#act(action, body, signal));
  }

  /** Switches to or closes the tab at `index`, in the order Revyl lists the tabs. */
  tab(action: 'tab_switch' | 'tab_close', index: number, context: OperationContext): Promise<void> {
    return withDeadline(context, action, async (signal) => {
      const tabs = await this.#bound.client.tabs(this.#bound.run, signal);
      const tab = tabs[index];
      if (tab === undefined) throw new TestError('ACTION_FAILED', `there is no tab ${index + 1}; ${tabs.length} are open`);
      if (action === 'tab_close' && tabs.length === 1) throw new TestError('ACTION_FAILED', `tab ${index + 1} is the only open tab`);
      await this.#act(action, { tab_id: tab.tab_id }, signal);
    });
  }

  resize(size: ViewportSize, context: OperationContext): Promise<void> {
    return withDeadline(context, 'resize', async (signal) => {
      await this.#act('viewport', { width: Math.round(size.width), height: Math.round(size.height) }, signal);
      await this.#readGeometry(signal);
    });
  }

  screenshot(label: string | undefined, context: OperationContext): Promise<string> {
    return withDeadline(context, 'screenshot', async (signal) => {
      if (this.artifactsDir === undefined) throw new EngineError('INVALID_STATE', 'no attempt is running', { retryable: false });
      await this.#refuseFilledPassword(signal);
      const bytes = await this.#bound.client.screenshot(this.#bound.run, signal);
      const slug = (label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
      const path = join('screenshots', `revyl-${++this.#screenshots}${slug === '' ? '' : `-${slug}`}.png`);
      await mkdir(join(this.artifactsDir, 'screenshots'), { recursive: true });
      await writeFile(join(this.artifactsDir, path), bytes);
      return path;
    });
  }

  /**
   * A screenshot artifact promises secure fields masked at the source, and
   * Revyl cannot mask one, so no screenshot is taken while a password field
   * is on screen without its placeholder showing. Revyl reports a password
   * field's text as empty whether or not it holds a value, so only a shown
   * placeholder proves it empty. It fails closed: a password answer that
   * matches no element counts by its own box.
   */
  async #refuseFilledPassword(signal: AbortSignal): Promise<void> {
    const [tree, matched] = await this.#read([{ kind: 'secure' }, { kind: 'placeholderShown' }], signal);
    const elements = flatten(tree);
    const answers = (kind: Mark['kind']): readonly MaestroNode[] => matched.flatMap(([mark, matches]) => (mark.kind === kind ? matches : []));
    const placeholders = answers('placeholderShown');
    const { width, height } = this.#viewport;
    const filled = [...secureNodes(elements, matched), ...answers('secure')].some((node) => {
      const { left, top, right, bottom } = node.attributes.bounds;
      const empty = placeholders.some((placeholder) => sameAttributes(placeholder, node));
      return !empty && right > Math.max(0, left) && bottom > Math.max(0, top) && left < width && top < height;
    });
    if (filled) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', 'revylWeb takes no screenshot while a filled password field is on screen: Revyl cannot mask it', { retryable: false });
    }
  }

  get #bound(): { client: RevylWebClient; run: string } {
    if (this.#client === undefined || this.#session === undefined) {
      throw new EngineError('INVALID_STATE', 'the Revyl web session is not running', { retryable: false });
    }
    return { client: this.#client, run: this.#session.workflowRunId };
  }

  async #perform(ref: NodeRef, action: LocatorAction, signal: AbortSignal): Promise<void> {
    if (ref.id === ROOT_ID) {
      if (action.kind !== 'swipe') throw new EngineError('UNSUPPORTED_CAPABILITY', `${action.kind} needs a node, not the page`, { retryable: false });
      return this.#scroll(this.#toPixels({ x: this.#viewport.width / 2, y: this.#viewport.height / 2 }), action.direction, this.#viewport, signal);
    }
    // Refusals come before the first request, so a refused action sends nothing.
    const key = action.kind === 'press' ? revylKey(action.key) : undefined;
    const option = action.kind === 'selectOption' ? optionLabel(action.value) : undefined;
    const { point, tree } = await this.#live(ref, signal);
    switch (action.kind) {
      case 'tap':
        return this.#act('tap', { ...point, ...modifiers(action.modifiers) }, signal);
      case 'secondaryTap':
        return this.#act('tap', { ...point, button: 'right', ...modifiers(action.modifiers) }, signal);
      case 'doubleTap':
        return this.#act('double_tap', { ...point, ...modifiers(action.modifiers) }, signal);
      case 'longPress':
        return this.#act('longpress', { ...point, ...(action.durationMs === undefined ? {} : { duration_ms: Math.min(5000, action.durationMs) }) }, signal);
      case 'hover':
        return this.#act('hover', point, signal);
      case 'fill':
        return this.#act('input', { ...point, text: action.value, clear_first: true }, signal, action.sensitive);
      case 'clear':
        return this.#act('clear_text', point, signal);
      case 'press':
        await this.#focus(ref, point, tree, signal);
        return this.#act('key', key, signal);
      case 'selectOption':
        return this.#act('select', { ...point, option_label: option }, signal);
      case 'swipe': {
        const { bounds } = this.#minted.get(ref.id)?.node.attributes ?? {};
        const box = bounds === undefined ? this.#viewport : { width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
        return this.#scroll(point, action.direction, box, signal);
      }
      case 'scrollIntoView':
        return;
      case 'dragTo': {
        const end = await this.#liveCentre(action.target, signal);
        return this.#drag(point, end, signal);
      }
      default:
        throw new EngineError('UNSUPPORTED_CAPABILITY', `revylWeb cannot perform "${action.kind}"`, { retryable: false });
    }
  }

  /**
   * Gives `ref` the keyboard focus before a key. Revyl has no focus action,
   * only a tap, and a tap activates anything but a text field (a button, a
   * link, a toggle, a switch, a tab, a slider); so an element that is not
   * focused already is tapped only when it is a text field, and the key is
   * refused otherwise.
   */
  async #focus(ref: NodeRef, point: { x: number; y: number }, tree: MaestroNode, signal: AbortSignal): Promise<void> {
    const elements = flatten(tree);
    const matched = await this.#answer(tree, [{ kind: 'focus' }, { kind: 'textEntry' }], signal);
    const has = (kind: Mark['kind']): boolean => matchElements(elements, matched.find(([mark]) => mark.kind === kind)?.[1] ?? []).has(ref.id);
    if (has('focus')) return;
    if (!has('textEntry')) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', 'Revyl focuses an element only by tapping it, which would activate anything but a text field; press keys on a focused element or a text field', { retryable: false });
    }
    // The tap only focuses the element; the key's own settle covers both.
    await this.#act('tap', { ...point, skip_settle: true }, signal);
  }

  async #performAt(point: ViewportPoint, action: PointerAction, signal: AbortSignal): Promise<void> {
    const at = this.#toPixels(point);
    switch (action.kind) {
      case 'tap':
        return this.#act('tap', at, signal);
      case 'secondaryTap':
        return this.#act('tap', { ...at, button: 'right' }, signal);
      case 'doubleTap':
        return this.#act('double_tap', at, signal);
      case 'hover':
        return this.#act('hover', at, signal);
      case 'longPress':
        return this.#act('longpress', { ...at, ...(action.durationMs === undefined ? {} : { duration_ms: Math.min(5000, action.durationMs) }) }, signal);
      case 'dragTo':
        return this.#drag(at, this.#toPixels(action.target), signal);
      default:
        throw new EngineError('UNSUPPORTED_CAPABILITY', `revylWeb cannot perform "${action.kind}" at a point`, { retryable: false });
    }
  }

  async #act(action: string, body: object | undefined, signal: AbortSignal, sensitive = false): Promise<void> {
    // Any action can change the page: no answer is kept across it, and a node
    // a scroll could not reach may be reachable after it.
    this.#answers = undefined;
    this.#scrolledFrom.clear();
    await this.#bound.client.act(this.#bound.run, action, body, signal, sensitive);
  }

  /**
   * Reads the hierarchy, then the CSS queries `marks` need. Revyl's worker
   * answers one request at a time, and a polling assertion reads the same
   * page again and again, so a structural query (a role, a test id) is asked
   * once per hierarchy: its answer is kept until the hierarchy changes or an
   * action runs. A state (`:checked`, `:disabled`) and a test's own CSS can
   * change while the hierarchy does not, as when a script enables a button,
   * so they are asked on every read. A field that shows text is asked about
   * once more, to tell an aria-label it shows because it is empty from a
   * value.
   *
   * To save a round trip, volatile answers go out with the hierarchy read,
   * and so does every other answer when an action has just run and none is
   * kept. The worker may answer those from an earlier page state than the
   * hierarchy's, so they serve this read only and are never kept, and the
   * marks that decide whether a field's text is reported at all (password,
   * field, and placeholder) are always asked after the hierarchy.
   */
  async #read(marks: readonly Mark[], signal: AbortSignal): Promise<readonly [MaestroNode, Matched]> {
    const early = marks.filter((mark) => isVolatile(mark) || (this.#answers === undefined && !guardsText(mark)));
    const [tree, asked] = await Promise.all([this.#bound.client.hierarchy(this.#bound.run, signal), this.#ask(early, signal)]);
    return [tree, await this.#answer(tree, marks, signal, asked)];
  }

  /**
   * The answers `marks` need on `tree`: those in `early`, asked along with
   * the hierarchy and used for this read only, then structural ones kept
   * for this hierarchy, then the rest, asked now; structural answers asked
   * now are kept. A field that shows text adds its aria-label check.
   */
  async #answer(tree: MaestroNode, marks: readonly Mark[], signal: AbortSignal, early = new Map<string, readonly MaestroNode[]>()): Promise<Matched> {
    const hierarchy = JSON.stringify(tree);
    if (this.#answers?.hierarchy !== hierarchy) this.#answers = { hierarchy, bySelector: new Map() };
    const kept = this.#answers.bySelector;
    const unknown = marks.filter((mark) => !early.has(markSelector(mark)) && (isVolatile(mark) || !kept.has(markSelector(mark))));
    const asked = await this.#ask(unknown, signal);
    for (const mark of unknown) if (!isVolatile(mark)) kept.set(markSelector(mark), asked.get(markSelector(mark)) ?? []);
    const answer = (mark: Mark): readonly MaestroNode[] => early.get(markSelector(mark)) ?? asked.get(markSelector(mark)) ?? kept.get(markSelector(mark)) ?? [];
    const matched = marks.map((mark) => [mark, answer(mark)] as const);
    const labels = labelShownMarks(flatten(tree), matched);
    return labels.length === 0 ? matched : [...matched, ...(await this.#answer(tree, labels, signal))];
  }

  /** Asks each distinct selector of `marks` once, in parallel. */
  async #ask(marks: readonly Mark[], signal: AbortSignal): Promise<Map<string, readonly MaestroNode[]>> {
    const bySelector = new Map(marks.map((mark) => [markSelector(mark), mark]));
    const answers = await Promise.all([...bySelector.values()].map((mark) => this.#query(mark, signal)));
    return new Map([...bySelector.keys()].map((selector, index) => [selector, answers[index] ?? []]));
  }

  /**
   * Closes every tab but the first. The worker can drop its connections as a
   * tab closes; the closing read, which is retried, settles that before the
   * attempt's first action is sent.
   */
  async #closeExtraTabs(signal: AbortSignal): Promise<void> {
    const tabs = await this.#bound.client.tabs(this.#bound.run, signal);
    const first = tabs[0];
    if (first === undefined || tabs.length === 1) return;
    if (!first.active) await this.#act('tab_switch', { tab_id: first.tab_id }, signal);
    for (const tab of tabs.slice(1)) await this.#act('tab_close', { tab_id: tab.tab_id }, signal);
    const left = await this.#bound.client.tabs(this.#bound.run, signal);
    if (left.length !== 1) throw new EngineError('INVALID_STATE', `Revyl kept ${left.length} tabs open after closing the extra ones`, { retryable: false });
  }

  /**
   * One CSS query. A refusal names only a value the test wrote into the CSS,
   * a selector, test id, or placeholder; the engine builds the rest, and they
   * can carry page text.
   */
  async #query(mark: Mark, signal: AbortSignal): Promise<readonly MaestroNode[]> {
    try {
      return await this.#bound.client.query(this.#bound.run, markSelector(mark), signal);
    } catch (error) {
      if (error instanceof RevylHttpError && error.status === 400) {
        const value = mark.kind === 'selector' ? mark.selector : mark.kind === 'testId' || mark.kind === 'placeholder' ? mark.value : undefined;
        if (value !== undefined) throw new EngineError('UNSUPPORTED_CAPABILITY', `Revyl refused the ${mark.kind} ${JSON.stringify(value)}`, { retryable: false, cause: error });
        throw new EngineError('ENGINE_FAILURE', `Revyl refused the engine's ${mark.kind} query`, { retryable: false });
      }
      throw error;
    }
  }

  /** Projects one read, minting every element; `observed` cuts text to the observation limits. */
  #project(tree: MaestroNode, matched: Matched, observed: boolean): SemanticNode {
    const elements = flatten(tree);
    const marks = new Map<string, Mark[]>();
    for (const [mark, matches] of matched) {
      for (const id of matchElements(elements, matches)) marks.set(id, [...(marks.get(id) ?? []), mark]);
    }
    for (const element of elements) this.#minted.set(element.id, { node: element.node, context: ancestry(tree, element.id) });
    const testIds = new Set(matched.flatMap(([mark]) => (mark.kind === 'testId' ? [mark.value] : [])));
    return project(elements, { marks, testIds, secure: secureNodes(elements, matched) }, this.#viewport, observed);
  }

  /**
   * The point to act on a node at, in screenshot pixels, read again from the
   * page: the centre of its part on screen. A node that changed since it was
   * handed out, or whose surroundings did, is `NODE_STALE`, and one wholly
   * off screen is scrolled toward and then `NODE_STALE`, so the runner
   * resolves it again where it now is.
   */
  async #liveCentre(ref: NodeRef, signal: AbortSignal): Promise<{ x: number; y: number }> {
    return (await this.#live(ref, signal)).point;
  }

  /** `#liveCentre`, and the hierarchy it read the node from. */
  async #live(ref: NodeRef, signal: AbortSignal): Promise<{ point: { x: number; y: number }; tree: MaestroNode }> {
    const minted = this.#minted.get(ref.id);
    if (minted === undefined) throw new EngineError('NODE_STALE', `node ${ref.id} was never observed`, { retryable: true });
    const tree = await this.#bound.client.hierarchy(this.#bound.run, signal);
    const live = elementAt(tree, ref.id);
    if (live === undefined || !sameAttributes(live, minted.node) || ancestry(tree, ref.id) !== minted.context) {
      throw new EngineError('NODE_STALE', `node ${ref.id} changed since it was located`, { retryable: true });
    }
    const { left, top, right, bottom } = live.attributes.bounds;
    if (right <= left || bottom <= top) throw new EngineError('NOT_ACTIONABLE', `node ${ref.id} has no size on the page`, { retryable: false });
    const { width, height } = this.#viewport;
    // The centre of the part on screen, so a list taller than the viewport
    // is acted on where it shows rather than scrolled to its middle.
    const shown = { left: Math.max(left, 0), top: Math.max(top, 0), right: Math.min(right, width), bottom: Math.min(bottom, height) };
    if (shown.right > shown.left && shown.bottom > shown.top) {
      this.#scrolledFrom.delete(ref.id);
      return { point: this.#toPixels({ x: (shown.left + shown.right) / 2, y: (shown.top + shown.bottom) / 2 }), tree };
    }
    const centre = { x: (left + right) / 2, y: (top + bottom) / 2 };
    const at = `${centre.x},${centre.y}`;
    if (this.#scrolledFrom.get(ref.id) === at) {
      throw new EngineError('NOT_ACTIONABLE', `node ${ref.id} is off screen, and scrolling did not bring it into view`, { retryable: false });
    }
    // Wheel from the point of the viewport nearest the node, a tenth in from
    // the edge, so a node in an inner scroller scrolls that scroller.
    const from = { x: clamp(centre.x, width * 0.1, width * 0.9), y: clamp(centre.y, height * 0.1, height * 0.9) };
    const dy = centre.y < 0 || centre.y >= height ? Math.round(centre.y - height / 2) : 0;
    const dx = centre.x < 0 || centre.x >= width ? Math.round(centre.x - width / 2) : 0;
    await this.#act('scroll', { ...this.#toPixels(from), dx, dy }, signal);
    this.#scrolledFrom.set(ref.id, at);
    throw new EngineError('NODE_STALE', `node ${ref.id} was off screen; scrolled it into view`, { retryable: true });
  }

  /**
   * Drags between two points in screenshot pixels. Revyl's worker stops
   * answering when it drags with a second tab open, which ends the session,
   * so a drag then is refused before it is sent.
   */
  async #drag(from: { x: number; y: number }, to: { x: number; y: number }, signal: AbortSignal): Promise<void> {
    const tabs = await this.#bound.client.tabs(this.#bound.run, signal);
    if (tabs.length > 1) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', `Revyl drags only with one tab open, and ${tabs.length} are open; close the others first`, { retryable: false });
    }
    await this.#act('drag', { start_x: from.x, start_y: from.y, end_x: to.x, end_y: to.y }, signal);
  }

  /** A CSS point as Revyl's pointer actions take it: screenshot pixels. */
  #toPixels(point: ViewportPoint): { x: number; y: number } {
    return { x: Math.round(point.x * this.#scale), y: Math.round(point.y * this.#scale) };
  }

  /** Scrolls by 80% of `box` in CSS pixels, from `at` in screenshot pixels. */
  async #scroll(at: ViewportPoint, direction: 'up' | 'down' | 'left' | 'right', box: ViewportSize, signal: AbortSignal): Promise<void> {
    const distanceY = Math.round(box.height * 0.8);
    const distanceX = Math.round(box.width * 0.8);
    const delta = { up: { dx: 0, dy: -distanceY }, down: { dx: 0, dy: distanceY }, left: { dx: -distanceX, dy: 0 }, right: { dx: distanceX, dy: 0 } }[direction];
    await this.#act('scroll', { x: Math.round(at.x), y: Math.round(at.y), ...delta }, signal);
  }

  async #readGeometry(signal: AbortSignal): Promise<void> {
    const info = await this.#bound.client.info(this.#bound.run, signal);
    this.#viewport = { width: info.width_grid, height: info.height_grid };
    this.#scale = info.width_pixels / info.width_grid;
  }

  #pixels(png: Uint8Array): NonNullable<EngineSnapshot['pixels']> {
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return { data: png, mediaType: 'image/png', width, height, scale: width / this.#viewport.width };
  }
}

/** Each mark a read asked about, with the elements its query matched. */
type Matched = ReadonlyArray<readonly [Mark, readonly MaestroNode[]]>;

/** A node as it was handed out, and its ancestors then. */
interface Minted {
  readonly node: MaestroNode;
  readonly context: string;
}

function elementAt(root: MaestroNode, id: string): MaestroNode | undefined {
  const path = id.split('.').slice(1);
  let node: MaestroNode | undefined = root;
  for (const step of path) node = node?.children[Number(step)];
  return node;
}

/**
 * The parent's and grandparent's subtree text, with every run of digits read
 * as one, and their child counts. Ids are positions, so a row prepended to a
 * list, or a row whose content was swapped in place, puts another element
 * with the same text and box where the old one was; the row's text tells the
 * two apart. A countdown or clock beside the node changes only digits, so it
 * does not count.
 */
function ancestry(root: MaestroNode, id: string): string {
  const path = id.split('.');
  return JSON.stringify(
    [path.slice(0, -1), path.slice(0, -2)]
      .filter((ancestor) => ancestor.length > 0)
      .map((ancestor) => {
        const node = elementAt(root, ancestor.join('.'));
        return node === undefined ? null : [subtreeText(node).replace(/\d+/g, '#'), node.children.length];
      }),
  );
}

function subtreeText(node: MaestroNode): string {
  return [node.attributes.text, ...node.children.map(subtreeText)].join(' ');
}

/** A mark that decides whether a field's text is reported at all: asked only after the hierarchy it applies to. */
function guardsText(mark: Mark): boolean {
  return mark.kind === 'secure' || mark.kind === 'placeholderShown' || mark.kind === 'field';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function modifiers(keys: readonly string[] | undefined): { modifiers?: string[] } {
  return keys === undefined || keys.length === 0 ? {} : { modifiers: keys.map((key) => MODIFIERS[key] ?? key) };
}

/** The label Revyl's `select` takes: a bare string or `{ label }`; a value or an index has none. */
function optionLabel(option: SelectOption): string {
  if (typeof option === 'string') return option;
  if ('label' in option && typeof option.label === 'string') return option.label;
  throw new EngineError('UNSUPPORTED_CAPABILITY', 'revylWeb selects an option by its label, not its value or index', { retryable: false });
}

/** A contract key as Revyl's `key` action takes it: a named key, or a letter or digit with a modifier. */
function revylKey(key: string): { key: string; modifiers: string[] } {
  const parsed = parseKey(key);
  if (parsed === undefined) throw new EngineError('UNSUPPORTED_CAPABILITY', `key ${JSON.stringify(key)} is not in the key grammar`, { retryable: false });
  const mods = parsed.modifiers.map((modifier) => MODIFIERS[modifier] ?? modifier);
  if (parsed.key.kind === 'named') {
    if (!NAMED_KEYS.has(parsed.key.name)) throw new EngineError('UNSUPPORTED_CAPABILITY', `Revyl cannot press ${parsed.key.name}`, { retryable: false });
    return { key: parsed.key.name, modifiers: mods };
  }
  if (parsed.key.char === ' ') return { key: 'Space', modifiers: mods };
  if (mods.length > 0 && /^[a-z0-9]$/i.test(parsed.key.char)) return { key: parsed.key.char, modifiers: mods };
  throw new EngineError('UNSUPPORTED_CAPABILITY', `Revyl presses a character only with a modifier; use fill to type "${parsed.key.char}"`, { retryable: false });
}

/**
 * Runs one operation under one deadline that every request it makes shares:
 * the harness signal does not abort at `timeoutMs`. The deadline aborts with
 * `OPERATION_TIMEOUT`, which a read rethrows and an action turns into
 * `ACTION_MAY_HAVE_COMMITTED`.
 */
async function withDeadline<T>(context: OperationContext, label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = Math.max(1, context.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new EngineError('OPERATION_TIMEOUT', `revylWeb ${label} took longer than ${timeoutMs} ms`, { retryable: false })), timeoutMs);
  try {
    return await work(AbortSignal.any([context.signal, controller.signal]));
  } finally {
    clearTimeout(timer);
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function ownVersion(): string {
  return (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
}
