/**
 * Actions: one function per kind, each waiting for its node as the kind
 * needs, then sending trusted input through the operation's input gate.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  EngineError,
  parseKey,
  sleep,
  TestError,
  pollCondition,
  type LocatorAction,
  type Momentum,
  type OperationContext,
  type PointerAction,
  type ScrollDirection,
  type ViewportPoint,
} from '@e2e-dev/core/engine';
import { actionablePoint, contentBox, waitReady, whole, type WaitTarget } from './actionability.ts';
import type { DevTools } from './devtools.ts';
import { lostFocus, notActionable, unsupported } from './errors.ts';
import { nextFrame, viewportSize } from './in-page/node-ops.ts';
import { bounded, inputGate, waitDeadline, type InputGate } from './input-gate.ts';
import type { AppWindow, Windows } from './windows.ts';

/** How long a long press holds by default. */
const LONG_PRESS_MS = 800;

/** What every action reads beside its window. */
export interface ActionContext {
  readonly devtools: DevTools;
  readonly windows: Windows;
  readonly projectRoot: string;
  /** How long an agent's action lets the UI settle before the agent reads the screen. */
  readonly settleMs: number;
}

/** One action on one node: the node it waits on, and `commit`, which sends input through the gate and marks the action as one that may have reached the app. */
interface Step extends WaitTarget {
  readonly context: ActionContext;
  readonly gate: InputGate;
  commit<T>(send: () => Promise<T>): Promise<T>;
}

type ActionOf<K extends LocatorAction['kind']> = Extract<LocatorAction, { readonly kind: K }>;

/** Performs a locator action on a node of the shown window. */
export async function performOnNode(context: ActionContext, window: AppWindow, backendNodeId: number, action: LocatorAction, operation: OperationContext): Promise<void> {
  // The wait for actionability ends a little before the operation does, so it reports why the node never became actionable.
  const deadline = waitDeadline(operation);
  const gate = inputGate(operation, action.kind);
  let committed = false;
  const step: Step = {
    context,
    devtools: context.devtools,
    window,
    backendNodeId,
    operation,
    deadline,
    gate,
    commit(send) {
      gate();
      committed = true;
      return send();
    },
  };
  await bounded(operation, action.kind, () => committed, () => runNodeAction(step, action));
  await settle(context, operation);
}

function runNodeAction(step: Step, action: LocatorAction): Promise<void> {
  switch (action.kind) {
    case 'tap':
    case 'doubleTap':
    case 'secondaryTap':
    case 'multiTap':
      return tap(step, action);
    case 'hover':
      return hover(step);
    case 'longPress':
      return longPress(step, action);
    case 'focus':
      return focus(step);
    case 'blur':
      return step.commit(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'blur'));
    case 'scrollIntoView':
      return scrollIntoView(step);
    case 'fill':
    case 'clear':
      return fill(step, action.kind === 'fill' ? action.value : '');
    case 'check':
    case 'uncheck':
      return setChecked(step, action.kind === 'check');
    case 'press':
      return press(step, action);
    case 'selectOption':
      return selectOption(step, action);
    case 'setInputFiles':
      return setInputFiles(step, action);
    case 'setInputFilePayloads':
      throw unsupported('in-memory files are not supported; pass file paths');
    case 'dragTo':
      return dragTo(step, action);
    case 'swipe':
      return swipeNode(step, action);
  }
}

async function tap(step: Step, action: ActionOf<'tap' | 'doubleTap' | 'secondaryTap' | 'multiTap'>): Promise<void> {
  const point = await actionablePoint(step, true);
  const clickCount = action.kind === 'doubleTap' ? 2 : action.kind === 'multiTap' ? action.count : 1;
  const modifiers = (action.modifiers ?? []).map(modifierKey);
  const { mouse } = step.window.page;
  await step.commit(() => withModifiers(step.window, modifiers, () => mouse.click(point.x, point.y, { clickCount, button: action.kind === 'secondaryTap' ? 'right' : 'left' })));
}

async function hover(step: Step): Promise<void> {
  const point = await actionablePoint(step, false);
  await step.commit(() => step.window.page.mouse.move(point.x, point.y));
}

async function longPress(step: Step, action: ActionOf<'longPress'>): Promise<void> {
  const point = await actionablePoint(step, true);
  const { mouse } = step.window.page;
  await step.commit(() => mouse.move(point.x, point.y));
  await step.commit(() => mouse.down());
  await hold(step.window, action.durationMs ?? LONG_PRESS_MS, step.operation, step.gate);
}

async function focus(step: Step): Promise<void> {
  // pressSequentially focuses, then types into whatever holds focus: the node must be the one that does.
  if (!(await step.commit(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'focus')))) throw lostFocus();
}

/** Scrolls the element into view, waiting until it has a box to scroll to: an element that is not rendered cannot be. */
async function scrollIntoView(step: Step): Promise<void> {
  const session = await step.devtools.session(step.window.page);
  await pollCondition({
    deadline: step.deadline,
    signal: step.operation.signal,
    negated: false,
    evaluate: async () => {
      await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: step.backendNodeId }).catch(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'scrollIntoView'));
      return (await contentBox(step)) !== undefined;
    },
    onTimeout: () => notActionable('the element cannot be scrolled into view: it has no box on screen (hidden, or empty)'),
  });
}

async function fill(step: Step, value: string): Promise<void> {
  const { devtools, window, backendNodeId } = step;
  await waitReady(step, 'checkEditable');
  // A date, time, color, or range input takes no typed text: its value is set, as Playwright's fill does.
  const set = await step.commit(() => devtools.callOn(window.page, backendNodeId, 'setValue', value));
  if (set !== null) {
    if (!set.ok) throw notActionable(set.reason);
    return;
  }
  // The app's focus handler can hand focus on; text goes only to the node that still holds it.
  if (!(await step.commit(() => devtools.callOn(window.page, backendNodeId, 'selectContents')))) throw lostFocus();
  // Both edit the selection as typing would, with input events and no key events, as fill promises.
  if (value === '') await step.commit(() => devtools.callOn(window.page, backendNodeId, 'deleteSelection'));
  else await step.commit(() => window.page.keyboard.insertText(value));
}

async function setChecked(step: Step, want: boolean): Promise<void> {
  const { devtools, window, backendNodeId } = step;
  const kind = want ? 'check' : 'uncheck';
  const now = await devtools.callOn(window.page, backendNodeId, 'readChecked');
  if (now === null) throw unsupported(`the element has no checked state to ${kind}`);
  if (now === want) return;
  // A click on a checked radio leaves it checked: only another radio of its group clears it.
  if (!want && (await devtools.callOn(window.page, backendNodeId, 'isRadio'))) throw notActionable('uncheck cannot clear a radio button; select another radio in its group');
  const point = await actionablePoint(step, true);
  await step.commit(() => window.page.mouse.click(point.x, point.y));
  // A custom widget can set its state in a later task: the state is polled until the deadline, as the checks before the click are.
  await pollCondition({
    deadline: step.deadline,
    signal: step.operation.signal,
    negated: false,
    evaluate: async () => (await devtools.callOn(window.page, backendNodeId, 'readChecked')) === want,
    onTimeout: () => notActionable(`clicking the element did not ${kind} it`),
  });
}

async function press(step: Step, action: ActionOf<'press'>): Promise<void> {
  // A key the keyboard cannot send is refused before focus moves.
  const key = playwrightKey(action.key);
  await waitReady(step, 'checkConnected');
  // The key goes to what holds focus after the node is focused, as on the web: a node that cannot take focus (a plain div) leaves it where it was.
  await step.commit(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'focus'));
  await step.commit(() => step.window.page.keyboard.press(key));
}

async function selectOption(step: Step, action: ActionOf<'selectOption'>): Promise<void> {
  const option = typeof action.value === 'string' ? { label: action.value } : action.value;
  // An app can fill its options in after a request: the wait lasts until the option is there and enabled.
  await waitReady(step, 'checkSelect', option);
  const outcome = await step.commit(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'selectOption', option));
  if (!outcome.ok) throw notActionable(outcome.reason);
}

async function setInputFiles(step: Step, action: ActionOf<'setInputFiles'>): Promise<void> {
  const files = action.paths.map((file) => path.resolve(step.context.projectRoot, file));
  // The DevTools call takes a path that names nothing and attaches nothing, reporting success.
  const missing = files.find((file) => !existsSync(file));
  if (missing !== undefined) throw new TestError('INVALID_ARGUMENT', `setInputFiles: no file at ${missing}`);
  await waitReady(step, 'checkFileInput');
  const takes = await step.devtools.callOn(step.window.page, step.backendNodeId, 'takesFiles', files.length);
  if (!takes.ok) throw new TestError('INVALID_ARGUMENT', `setInputFiles: ${takes.reason}`);
  // The DevTools call leaves the input as it was for an empty list; `[]` clears it.
  if (files.length === 0) {
    await step.commit(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'clearFiles'));
    return;
  }
  const session = await step.devtools.session(step.window.page);
  await step.commit(() => session.send('DOM.setFileInputFiles', { files, backendNodeId: step.backendNodeId }));
}

async function dragTo(step: Step, action: ActionOf<'dragTo'>): Promise<void> {
  const target = step.context.windows.bind(action.target);
  const { mouse } = step.window.page;
  // The source is pressed where it is now; only then does the target scroll into view, under the held pointer.
  const from = await actionablePoint(step, true);
  await step.commit(() => mouse.move(from.x, from.y));
  await step.commit(() => mouse.down());
  try {
    // The target is waited for as the source was: in view, and the topmost element at the point the drop lands on.
    const to = await actionablePoint({ ...step, backendNodeId: target.backendNodeId }, false).catch((cause: unknown) => {
      if (cause instanceof EngineError && cause.code === 'NOT_ACTIONABLE') {
        throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `the drop target ${cause.message.replace(/^the element /, '')}, and the source was already pressed`, { retryable: false, cause });
      }
      throw cause;
    });
    // An intermediate move, so drag handlers see motion before the drop.
    await step.commit(() => mouse.move(Math.round((from.x + to.x) / 2), Math.round((from.y + to.y) / 2)));
    await step.commit(() => mouse.move(to.x, to.y));
  } finally {
    await mouse.up();
  }
}

async function swipeNode(step: Step, action: ActionOf<'swipe'>): Promise<void> {
  const point = await actionablePoint(step, false);
  // The layout can change after the wait for actionability read the box.
  const box = await contentBox(step);
  if (box === undefined) throw notActionable('the element has no box on screen to swipe');
  await step.commit(() => step.window.page.mouse.move(point.x, point.y));
  await step.commit(() => wheel(step.devtools, step.window, action.direction, action.momentum ?? 'none', box));
}

/** A swipe on the window itself, from its centre. */
export async function swipeWindow(context: ActionContext, window: AppWindow, action: ActionOf<'swipe'>, operation: OperationContext): Promise<void> {
  const gate = inputGate(operation, 'swipe');
  let committed = false;
  await bounded(operation, 'swipe', () => committed, async () => {
    const size = await context.devtools.evaluate(window.page, viewportSize);
    gate();
    committed = true;
    await window.page.mouse.move(Math.round(size.width / 2), Math.round(size.height / 2));
    gate();
    await wheel(context.devtools, window, action.direction, action.momentum ?? 'none', size);
  });
  await settle(context, operation);
}

/** A pointer action at a viewport point of the shown window. */
export async function performAtPoint(context: ActionContext, window: AppWindow, point: ViewportPoint, action: PointerAction, operation: OperationContext): Promise<void> {
  const at = whole(point);
  const { mouse } = window.page;
  const gate = inputGate(operation, action.kind);
  await bounded(operation, action.kind, true, async () => {
    switch (action.kind) {
      case 'tap':
        await mouse.click(at.x, at.y);
        return;
      case 'doubleTap':
        await mouse.click(at.x, at.y, { clickCount: 2 });
        return;
      case 'secondaryTap':
        await mouse.click(at.x, at.y, { button: 'right' });
        return;
      case 'hover':
        await mouse.move(at.x, at.y);
        return;
      case 'longPress':
        await mouse.move(at.x, at.y);
        await mouse.down();
        await hold(window, action.durationMs ?? LONG_PRESS_MS, operation, gate);
        return;
      case 'dragTo':
        await drag(window, at, whole(action.target), gate);
        return;
      case 'swipeTo':
        await drag(window, at, whole(action.target), gate, action.durationMs ?? 300, operation.signal);
        return;
      case 'swipe': {
        gate();
        await mouse.move(at.x, at.y);
        const size = await context.devtools.evaluate(window.page, viewportSize);
        gate();
        await wheel(context.devtools, window, action.direction, action.momentum ?? 'none', size);
        return;
      }
    }
  });
  await settle(context, operation);
}

/** Types into the focused element of the shown window, one character at a time through the gate. */
export async function typeText(context: ActionContext, window: AppWindow, text: string, replace: boolean, operation: OperationContext): Promise<void> {
  const { keyboard } = window.page;
  const gate = inputGate(operation, 'keyboard.type');
  await bounded(operation, 'keyboard.type', true, async () => {
    if (!(await context.devtools.focusedTakesText(window.page))) throw notActionable('nothing that takes text has keyboard focus; tap the field first');
    if (replace) {
      gate();
      await keyboard.press('ControlOrMeta+A');
      gate();
      await keyboard.press('Delete');
    }
    // No key goes out once the caller stopped waiting.
    for (const character of text) {
      gate();
      await keyboard.type(character);
    }
  });
  await settle(context, operation);
}

/** Presses a key in the shown window, wherever focus is. */
export async function pressKey(context: ActionContext, window: AppWindow, key: string, operation: OperationContext): Promise<void> {
  const sent = playwrightKey(key);
  await bounded(operation, 'keyboard.press', true, () => window.page.keyboard.press(sent));
  await settle(context, operation);
}

/** The agent reads the screen right after acting, so its actions let the UI settle first; a test's own steps verify with `expect`. */
async function settle(context: ActionContext, operation: OperationContext): Promise<void> {
  if (operation.origin === 'agent') await sleep(Math.min(context.settleMs, operation.timeoutMs), operation.signal);
}

/**
 * Holds a pressed button for `durationMs`, never past the operation's end,
 * and releases it whatever happens: a release that waited for a press
 * longer than its operation would land on whatever control the next action
 * leaves the pointer over.
 */
async function hold(window: AppWindow, durationMs: number, operation: OperationContext, gate: InputGate): Promise<void> {
  try {
    await sleep(Math.min(durationMs, gate.deadline.remaining()), operation.signal);
  } finally {
    await window.page.mouse.up();
  }
  gate();
}

/** A pointer drag between two points, paced over `durationMs` when given; every move passes the gate. */
async function drag(window: AppWindow, from: ViewportPoint, to: ViewportPoint, gate: InputGate, durationMs?: number, signal?: AbortSignal): Promise<void> {
  const { mouse } = window.page;
  gate();
  await mouse.move(from.x, from.y);
  await mouse.down();
  try {
    const steps = durationMs === undefined ? 2 : Math.max(2, Math.round(durationMs / 16));
    for (let step = 1; step <= steps; step += 1) {
      gate();
      await mouse.move(Math.round(from.x + ((to.x - from.x) * step) / steps), Math.round(from.y + ((to.y - from.y) * step) / steps));
      if (durationMs !== undefined) await sleep(durationMs / steps, signal);
    }
  } finally {
    await mouse.up();
  }
}

async function withModifiers(window: AppWindow, modifiers: readonly string[], work: () => Promise<void>): Promise<void> {
  const { keyboard } = window.page;
  for (const modifier of modifiers) await keyboard.down(modifier);
  try {
    await work();
  } finally {
    for (const modifier of modifiers.toReversed()) await keyboard.up(modifier);
  }
}

/** A wheel scroll over a box, its distance a share of the box by momentum, then a frame for the app to render it. */
async function wheel(devtools: DevTools, window: AppWindow, direction: ScrollDirection, momentum: Momentum, box: { readonly width: number; readonly height: number }): Promise<void> {
  const extent = direction === 'up' || direction === 'down' ? box.height : box.width;
  const distance = Math.max(1, Math.round(extent * (momentum === 'fast' ? 1.5 : momentum === 'slow' ? 0.75 : 0.5)));
  const [deltaX, deltaY] = direction === 'down' ? [0, distance] : direction === 'up' ? [0, -distance] : direction === 'right' ? [distance, 0] : [-distance, 0];
  await window.page.mouse.wheel(deltaX, deltaY);
  await devtools.evaluate(window.page, nextFrame);
}

function modifierKey(modifier: string): string {
  return modifier === 'ControlOrMeta' ? (process.platform === 'darwin' ? 'Meta' : 'Control') : modifier;
}

/**
 * A key of the contract grammar in Playwright's spelling: the same names, and
 * `Space` as the space character. Playwright's keyboard knows the named keys
 * and the printable ASCII characters; any other character (`é`, `ß`) is
 * `UNSUPPORTED_CAPABILITY`, as the contract asks of a key a surface cannot
 * deliver.
 */
function playwrightKey(key: string): string {
  const parsed = parseKey(key);
  if (parsed === undefined) throw unsupported(`${JSON.stringify(key)} is not a key of the contract grammar`);
  if (parsed.key.kind === 'char' && !/^[\x20-\x7e]$/.test(parsed.key.char)) {
    throw unsupported(`the keyboard cannot press ${JSON.stringify(parsed.key.char)}: only named keys and printable ASCII characters have a key; type other text with fill or pressSequentially`);
  }
  return key === 'Space' ? ' ' : key.replace(/\+Space$/, '+ ');
}
