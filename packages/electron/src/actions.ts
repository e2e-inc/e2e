/**
 * Actions: one function per kind, each waiting for its node as the kind
 * needs, then sending trusted input through the operation's budget. A node
 * action finds the point to act at and makes the gesture a point action
 * makes there.
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
  type PointerAction,
  type ScrollDirection,
  type ViewportPoint,
} from '@e2e-dev/core/engine';
import { actionablePoint, contentBox, waitReady, whole, type WaitTarget } from './actionability.ts';
import type { Budget } from './budget.ts';
import type { DevTools } from './devtools.ts';
import { lostFocus, notActionable, unsupported } from './errors.ts';
import { nextFrame, viewportSize } from './in-page/node-ops.ts';
import type { AppWindow, Windows } from './windows.ts';

/** How long a long press holds by default. */
const LONG_PRESS_MS = 800;

/** How long before its operation ends a held press is released: time for the release to reach the app. */
const RELEASE_MARGIN_MS = 100;

/** How long a paced drag (`swipeTo`) takes by default. */
const SWIPE_TO_MS = 300;

/** The time between two moves of a paced drag: one frame at 60 Hz. */
const FRAME_MS = 16;

/** The share of a box one wheel scroll covers, by momentum, as the web engine scrolls. */
const WHEEL_SHARE: Readonly<Record<Momentum, number>> = { none: 0.5, slow: 0.75, fast: 1.5 };

/** What every action reads beside its window. */
export interface ActionContext {
  readonly devtools: DevTools;
  readonly windows: Windows;
  readonly projectRoot: string;
}

/** One action on one node: the node it waits on, and the budget its input goes through. */
interface Step extends WaitTarget {
  readonly context: ActionContext;
  readonly budget: Budget;
}

type ActionOf<K extends LocatorAction['kind']> = Extract<LocatorAction, { readonly kind: K }>;

interface Size {
  readonly width: number;
  readonly height: number;
}

/** Performs a locator action on a node of the shown window. */
export function performOnNode(context: ActionContext, window: AppWindow, backendNodeId: number, action: LocatorAction, budget: Budget): Promise<void> {
  const step: Step = { context, devtools: context.devtools, window, backendNodeId, operation: budget.operation, deadline: budget.waits, budget };
  switch (action.kind) {
    case 'tap':
    case 'doubleTap':
    case 'secondaryTap':
    case 'multiTap':
      return tap(step, action);
    case 'hover':
      return actionablePoint(step, false).then((point) => hover(budget, window, point));
    case 'longPress':
      return actionablePoint(step, true).then((point) => longPress(budget, window, point, action.durationMs));
    case 'focus':
      return focus(step);
    case 'blur':
      return budget.send(() => step.devtools.callOn(window.page, backendNodeId, 'blur'));
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

/** A pointer action at a viewport point of the shown window. */
export async function performAtPoint(context: ActionContext, window: AppWindow, point: ViewportPoint, action: PointerAction, budget: Budget): Promise<void> {
  const at = whole(point);
  switch (action.kind) {
    case 'tap':
      return click(budget, window, at, {});
    case 'doubleTap':
      return click(budget, window, at, { clickCount: 2 });
    case 'secondaryTap':
      return click(budget, window, at, { button: 'right' });
    case 'hover':
      return hover(budget, window, at);
    case 'longPress':
      return longPress(budget, window, at, action.durationMs);
    case 'dragTo':
      return drag(budget, window, at, () => Promise.resolve(whole(action.target)));
    case 'swipeTo':
      return drag(budget, window, at, () => Promise.resolve(whole(action.target)), action.durationMs ?? SWIPE_TO_MS);
    case 'swipe':
      return swipe(budget, context.devtools, window, at, await context.devtools.evaluate(window.page, viewportSize), action);
  }
}

/** A swipe on the window itself, from its centre. */
export async function swipeWindow(context: ActionContext, window: AppWindow, action: ActionOf<'swipe'>, budget: Budget): Promise<void> {
  const size = await context.devtools.evaluate(window.page, viewportSize);
  await swipe(budget, context.devtools, window, whole({ x: size.width / 2, y: size.height / 2 }), size, action);
}

/** Types into the focused element of the shown window, one character at a time: no key goes out once the caller stopped waiting. */
export async function typeText(context: ActionContext, window: AppWindow, text: string, replace: boolean, budget: Budget): Promise<void> {
  const { keyboard } = window.page;
  if (!(await context.devtools.focusedTakesText(window.page))) throw notActionable('nothing that takes text has keyboard focus; tap the field first');
  if (replace) {
    await budget.send(() => keyboard.press('ControlOrMeta+A'));
    await budget.send(() => keyboard.press('Delete'));
  }
  for (const character of text) await budget.send(() => keyboard.type(character));
}

/** Presses a key in the shown window, wherever focus is. */
export async function pressKey(window: AppWindow, key: string, budget: Budget): Promise<void> {
  const sent = playwrightKey(key);
  await budget.send(() => window.page.keyboard.press(sent));
}

// --- node actions ---

async function tap(step: Step, action: ActionOf<'tap' | 'doubleTap' | 'secondaryTap' | 'multiTap'>): Promise<void> {
  const point = await actionablePoint(step, true);
  await click(step.budget, step.window, point, {
    clickCount: action.kind === 'doubleTap' ? 2 : action.kind === 'multiTap' ? action.count : 1,
    button: action.kind === 'secondaryTap' ? 'right' : 'left',
    modifiers: (action.modifiers ?? []).map(modifierKey),
  });
}

async function focus(step: Step): Promise<void> {
  // pressSequentially focuses, then types into whatever holds focus: the node must be the one that does. An element that
  // cannot take focus leaves it where it was, as on the web; the typing that follows says nothing takes text.
  if ((await step.budget.send(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'focus'))) === 'moved') throw lostFocus();
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
  const { devtools, window, backendNodeId, budget } = step;
  await waitReady(step, 'checkEditable');
  // A date, time, color, or range input takes no typed text: its value is set, as Playwright's fill does.
  const set = await budget.send(() => devtools.callOn(window.page, backendNodeId, 'setValue', value));
  if (set !== null) {
    if (!set.ok) throw notActionable(set.reason);
    return;
  }
  // The app's focus handler can hand focus on; text goes only to the node that still holds it.
  if (!(await budget.send(() => devtools.callOn(window.page, backendNodeId, 'selectContents')))) throw lostFocus();
  // Text replaces the selection as typing would, with input events and no key events, as fill promises; an empty value
  // is a Delete key, as Playwright's fill sends it, so an editor that keeps its own model sees beforeinput.
  if (value === '') await budget.send(() => window.page.keyboard.press('Delete'));
  else await budget.send(() => window.page.keyboard.insertText(value));
}

async function setChecked(step: Step, want: boolean): Promise<void> {
  const { devtools, window, backendNodeId } = step;
  const kind = want ? 'check' : 'uncheck';
  const now = await devtools.callOn(window.page, backendNodeId, 'readChecked');
  if (now === null) throw notActionable(`the element has no checked state to ${kind}: it is no checkbox, radio, or switch`);
  if (now === want) return;
  // A click on a checked radio leaves it checked: only another radio of its group clears it.
  if (!want && (await devtools.callOn(window.page, backendNodeId, 'isRadio'))) throw notActionable('uncheck cannot clear a radio button; select another radio in its group');
  await click(step.budget, window, await actionablePoint(step, true), {});
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
  await step.budget.send(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'focus'));
  await step.budget.send(() => step.window.page.keyboard.press(key));
}

async function selectOption(step: Step, action: ActionOf<'selectOption'>): Promise<void> {
  const option = typeof action.value === 'string' ? { label: action.value } : action.value;
  // An app can fill its options in after a request: the wait lasts until the option is there and enabled.
  await waitReady(step, 'checkSelect', option);
  const outcome = await step.budget.send(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'selectOption', option));
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
    await step.budget.send(() => step.devtools.callOn(step.window.page, step.backendNodeId, 'clearFiles'));
    return;
  }
  const session = await step.devtools.session(step.window.page);
  await step.budget.send(() => session.send('DOM.setFileInputFiles', { files, backendNodeId: step.backendNodeId }));
}

async function dragTo(step: Step, action: ActionOf<'dragTo'>): Promise<void> {
  const target = step.context.windows.bind(action.target);
  // The source is pressed where it is now; only then does the target scroll into view, under the held pointer. It is
  // waited for as the source was: in view, and the topmost element at the point the drop lands on.
  await drag(step.budget, step.window, await actionablePoint(step, true), () =>
    actionablePoint({ ...step, backendNodeId: target.backendNodeId }, false).catch((cause: unknown) => {
      if (cause instanceof EngineError && cause.code === 'NOT_ACTIONABLE') {
        throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `the drop target ${cause.message.replace(/^the element /, '')}, and the source was already pressed`, { retryable: false, cause });
      }
      throw cause;
    }),
  );
}

async function swipeNode(step: Step, action: ActionOf<'swipe'>): Promise<void> {
  const point = await actionablePoint(step, false);
  // The layout can change after the wait for actionability read the box.
  const box = await contentBox(step);
  if (box === undefined) throw notActionable('the element has no box on screen to swipe');
  await swipe(step.budget, step.devtools, step.window, point, box, action);
}

// --- pointer gestures at a point, which node and point actions share ---

async function click(budget: Budget, window: AppWindow, at: ViewportPoint, options: { readonly clickCount?: number; readonly button?: 'left' | 'right'; readonly modifiers?: readonly string[] }): Promise<void> {
  const { clickCount = 1, button = 'left', modifiers = [] } = options;
  await budget.send(() => withModifiers(window, modifiers, () => window.page.mouse.click(at.x, at.y, { clickCount, button })));
}

async function hover(budget: Budget, window: AppWindow, at: ViewportPoint): Promise<void> {
  await budget.send(() => window.page.mouse.move(at.x, at.y));
}

/**
 * Presses at a point and holds for `durationMs`, never past the operation's
 * end, and releases whatever happens: a release that waited for a press
 * longer than its operation would land on whatever control the next action
 * leaves the pointer over.
 */
async function longPress(budget: Budget, window: AppWindow, at: ViewportPoint, durationMs = LONG_PRESS_MS): Promise<void> {
  const { mouse } = window.page;
  await budget.send(() => mouse.move(at.x, at.y));
  await budget.send(() => mouse.down());
  // The release lands before the operation's bound fires, so a press its budget cuts short is up when the step fails.
  const held = Math.min(durationMs, Math.max(0, budget.deadline.remaining() - RELEASE_MARGIN_MS));
  try {
    await sleep(held, budget.operation.signal);
  } finally {
    await mouse.up();
  }
  budget.check();
  if (held < durationMs) throw new EngineError('OPERATION_TIMEOUT', `the press was released after ${Math.round(held)}ms of ${durationMs}ms: the step's timeout ran out`, { retryable: false });
}

/**
 * Presses at `from` and drags to the point `target` answers once the pointer
 * is down, through a move in between so drag handlers see motion before the
 * drop; paced over `durationMs` when given.
 */
async function drag(budget: Budget, window: AppWindow, from: ViewportPoint, target: () => Promise<ViewportPoint>, durationMs?: number): Promise<void> {
  const { mouse } = window.page;
  await budget.send(() => mouse.move(from.x, from.y));
  await budget.send(() => mouse.down());
  try {
    const to = await target();
    const steps = durationMs === undefined ? 2 : Math.max(2, Math.round(durationMs / FRAME_MS));
    for (let step = 1; step <= steps; step += 1) {
      await budget.send(() => mouse.move(Math.round(from.x + ((to.x - from.x) * step) / steps), Math.round(from.y + ((to.y - from.y) * step) / steps)));
      if (durationMs !== undefined) await sleep(durationMs / steps, budget.operation.signal);
    }
  } finally {
    await mouse.up();
  }
}

/** A wheel scroll with the pointer at a point, its distance a share of `box` by momentum, then a frame for the app to render it. */
async function swipe(budget: Budget, devtools: DevTools, window: AppWindow, at: ViewportPoint, box: Size, action: { readonly direction: ScrollDirection; readonly momentum?: Momentum }): Promise<void> {
  const { direction } = action;
  const extent = direction === 'up' || direction === 'down' ? box.height : box.width;
  const distance = Math.max(1, Math.round(extent * WHEEL_SHARE[action.momentum ?? 'none']));
  const [deltaX, deltaY] = direction === 'down' ? [0, distance] : direction === 'up' ? [0, -distance] : direction === 'right' ? [distance, 0] : [-distance, 0];
  await budget.send(() => window.page.mouse.move(at.x, at.y));
  await budget.send(() => window.page.mouse.wheel(deltaX, deltaY));
  await devtools.evaluate(window.page, nextFrame);
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
