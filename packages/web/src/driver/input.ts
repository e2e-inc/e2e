/**
 * The keyboard and mouse of one attempt: the only sender of input,
 * WebDriver BiDi `input.performActions` and Chromium's CDP input commands
 * alike, and the keeper of what that input leaves behind in each tab (the
 * keys and buttons held, where the mouse is) and of how much input went out.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Protocol } from 'devtools-protocol';
import type { Input } from 'webdriver-bidi-protocol';
import { TestError, type ViewportPoint, type ViewportSize } from '@e2e-dev/core/engine';
import { ChromiumCdp } from './cdp.ts';
import { chromiumKeyCommands, chromiumTypedCommands, holdsAfter, type CdpKeyCommand } from './chromium-keys.ts';
import { codeOfValue, MODIFIER_CODES, pressStroke, strokeSource, type KeyStroke, type Modifier } from './keyboard.ts';
import type { BrowserTraits } from '../browsers.ts';
import { nextFrame } from '../in-page/document.ts';
import { holdsFocus } from '../in-page/edits.ts';
import type { BidiConnection } from './connection.ts';
import { BidiError, unlessStale } from '../errors.ts';
import { callFunction } from './script.ts';

/** A key held down, and how: a BiDi key action with its value, which its release repeats, or a CDP key event, which only CDP releases. */
type HeldKey = { readonly via: 'bidi'; readonly value: string } | { readonly via: 'cdp' };

/** What the input reaches the tab through. */
export interface InputTarget {
  readonly connection: BidiConnection;
  readonly traits: BrowserTraits;
  /** The tab shown, which input goes to; throws when none is open. */
  readonly context: () => string;
  /** The viewport in CSS pixels, which every pointer target must lie in. */
  readonly viewport: () => Promise<ViewportSize>;
}

/**
 * The input state of one tab, which the driver mirrors. Chromium and Firefox
 * both keep it per top-level browsing context for as long as the tab is
 * open, whichever tab is shown: a key or button held in one tab is not held
 * in another, each tab's mouse starts at the origin, and a tab shown again
 * still holds what it held and has its mouse where it was left. One object
 * for the tab's whole life: input records what it leaves in the state it
 * read, so input still in flight when its tab closes changes nothing in the
 * state of the tab shown next.
 */
class InputState {
  constructor(
    /** The keys held, by layout `code`. */
    public keys = new Map<string, HeldKey>(),
    /** The mouse buttons held. */
    public buttons = new Set<number>(),
    /** Where the mouse last moved. */
    public pointer: ViewportPoint = { x: 0, y: 0 },
  ) {}

  /** A copy to stage the effect of input on before the browser takes it. */
  copy(): InputState {
    return new InputState(new Map(this.keys), new Set(this.buttons), this.pointer);
  }

  /** Becomes what input left on a copy of it (`staged`), once the browser took that input. */
  take(staged: InputState): void {
    this.keys = staged.keys;
    this.buttons = staged.buttons;
    this.pointer = staged.pointer;
  }

  /** The modifiers held, on either side. */
  modifiers(): Set<Modifier> {
    const held = new Set<Modifier>();
    for (const code of this.keys.keys()) {
      const modifier = MODIFIER_CODES.get(code);
      if (modifier !== undefined) held.add(modifier);
    }
    return held;
  }
}

/** The dispatch count of the operation running now (`DispatchScope`). */
const operationDispatches = new AsyncLocalStorage<DispatchScope>();

/**
 * One operation's own dispatch count, so whether it sent input that may have
 * reached the app is read off its own sends: input or an evaluate another
 * operation runs meanwhile does not count, nor does a send or mutation of
 * its own that the page turned out not to take (`BidiInput.takeBack`).
 */
export class DispatchScope {
  private count = 0;

  /** Runs `work` with every input send and page mutation it makes counted here too. */
  run<T>(work: () => Promise<T>): Promise<T> {
    return operationDispatches.run(this, work);
  }

  /** Counts one send or mutation of `run`'s work (1), or takes one back (-1). */
  add(delta: 1 | -1): void {
    this.count += delta;
  }

  /** Whether `run`'s work sent input or changed the page, or has a send whose verdict is still out. */
  get dispatched(): boolean {
    return this.count > 0;
  }
}

/** A watch the page keeps on input it may suppress before any listener of the app sees it. */
interface InputWatch<V> {
  /** Starts the watch in the page. */
  readonly arm: () => Promise<void>;
  /** Ends the watch and reads what it saw. */
  readonly verdict: () => Promise<V>;
  /** Whether `verdict` says the page swallowed the input. */
  readonly suppressed: (verdict: V) => boolean;
}

/** The keyboard and mouse of one attempt, which go to the tab it shows. */
export class BidiInput {
  /** The state of each tab input went to, by its browsing context, until the tab closes (`forget`). */
  private readonly states = new Map<string, InputState>();
  private total = 0;
  private cdpSession: { readonly context: string; readonly cdp: Promise<ChromiumCdp> } | undefined;

  constructor(private readonly target: InputTarget) {}

  /**
   * Input sends and page mutations so far. It never decreases: the pointer
   * move and the modifier keys of a click the page swallowed still reached
   * the app, so a ref located before one is checked again
   * (`BidiRefs.claimFresh`), as is one located before a mutation that
   * changed nothing.
   */
  get dispatches(): number {
    return this.total;
  }

  /** Where the shown tab's mouse last moved, which a viewport swipe wheels at; throws when no tab is open. */
  get pointer(): ViewportPoint {
    return this.state.pointer;
  }

  /** The state of the tab shown; throws when none is open. */
  private get state(): InputState {
    return this.stateOf(this.target.context());
  }

  /** The state of the tab `context`: nothing held and the mouse at the origin until input went to it. */
  private stateOf(context: string): InputState {
    let state = this.states.get(context);
    if (state === undefined) {
      state = new InputState();
      this.states.set(context, state);
    }
    return state;
  }

  /** Counts a change the driver or the test's code makes in the page (a fill, a select, an evaluate), which may reach the app. */
  mutated(): void {
    this.count();
  }

  /** Counts one input send or page mutation, for the attempt and for the operation running it (`DispatchScope`). */
  private count(): void {
    this.total += 1;
    operationDispatches.getStore()?.add(1);
  }

  /**
   * Whether the operation running now sent input or changed the page so far
   * (`DispatchScope.dispatched`), which decides how a failure after it
   * reads: nothing happened, or the app may have taken part of it.
   */
  get dispatched(): boolean {
    return operationDispatches.getStore()?.dispatched === true;
  }

  /**
   * Takes one send or mutation back from the operation that counted it, once
   * the page turned out not to take it: a click it swallowed, a fill that
   * changed nothing. The attempt's count keeps it (`dispatches`).
   */
  takeBack(): void {
    operationDispatches.getStore()?.add(-1);
  }

  /** Forgets what the tab `context` held and where its mouse was, once the browser closed it. */
  forget(context: string): void {
    this.states.delete(context);
  }

  /**
   * Has the page of the tab `context` behave as focused whatever window or
   * tab the system shows in front of it, where the browser emulates focus
   * per tab (`BrowserTraits.focus`): its documents report focus, its fields
   * get their `focus` and `blur`, and text typed there is taken, in a
   * headed window behind another as in a headless one. It lasts as long as
   * the tab, through its navigations. Elsewhere it does nothing: the tab at
   * the front holds focus (`holdFocus`).
   */
  async emulateFocus(context: string): Promise<void> {
    if (this.target.traits.focus !== 'emulated') return;
    const cdp = await ChromiumCdp.forContext(this.target.connection, context);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  }

  /**
   * Resolves once the shown tab holds the browser's focus, where only the
   * tab at the front does (`BrowserTraits.focus`): one that lost the front,
   * to a tab the app opened or to another window, is brought back to it.
   * Keys reach a tab without it, but text inserted where focus is does not,
   * so a string typed there would be entered in part. A tab whose document
   * went away under the read is left to the input that follows.
   */
  async holdFocus(): Promise<void> {
    if (this.target.traits.focus !== 'front-tab') return;
    const { connection } = this.target;
    const context = this.target.context();
    if (await unlessStale(callFunction(connection, context, holdsFocus), true) === true) return;
    await connection.send('browsingContext.activate', { context });
  }

  /**
   * Runs input sources on the tab. A pointer target outside the viewport is
   * refused before anything is sent. A modifier already held is neither
   * pressed nor released again, a key is released with the value that
   * pressed it, and a move while a button is down carries pressure. The
   * state the input leaves is recorded once the browser took it. Nothing is
   * sent once `signal` aborted.
   */
  async send(actions: readonly Input.SourceActions[], signal?: AbortSignal): Promise<void> {
    const { context, sent, state, after } = await this.prepare(actions, signal);
    this.count();
    await this.perform(context, sent);
    state.take(after);
  }

  /**
   * Runs input sources the page may suppress before any listener of the app
   * sees them (the hit interceptor of a click). The watch is armed only once
   * the sources are ready to go out, so input refused or cancelled before
   * that leaves none armed, and its verdict is read whatever came after, which
   * ends it. Nothing is sent once the arm failed or `signal` aborted. The
   * operation counts the input as dispatched from the moment it goes out
   * until the verdict takes that back; a send or verdict that fails, or never
   * settles, leaves it counted. The attempt's count keeps a swallowed send
   * (`dispatches`). A failure throws once the verdict is read, unless the
   * browsing context went away under input that went out (one that closes its
   * own tab): that input was taken.
   */
  async sendSuppressible<V>(actions: readonly Input.SourceActions[], signal: AbortSignal, watch: InputWatch<V>): Promise<V> {
    const { context, sent, state, after } = await this.prepare(actions, signal);
    let dispatched = false;
    let failure: { cause: unknown } | undefined;
    try {
      await watch.arm();
      signal.throwIfAborted();
      dispatched = true;
      this.count();
      await this.perform(context, sent);
      state.take(after);
    } catch (cause) {
      failure = { cause };
    }
    let read: V;
    try {
      read = await watch.verdict();
    } catch (cause) {
      throw failure === undefined ? cause : failure.cause;
    }
    if (failure !== undefined && (!dispatched || !(failure.cause instanceof BidiError && failure.cause.error === 'no such frame'))) throw failure.cause;
    if (watch.suppressed(read)) this.takeBack();
    return read;
  }

  /** Whether Shift, and no other modifier, is held in the tab input goes to: where a key press types its key's shifted character. */
  holdsShiftAlone(): boolean {
    const held = this.state.modifiers();
    return held.size === 1 && held.has('Shift');
  }

  /**
   * Types `characters` as written under the modifiers held, each with its
   * key's events, where a key event can say what text its key enters
   * (Chromium, over CDP: `chromiumTypedCommands`). False, with nothing
   * sent, on a browser whose key events cannot.
   */
  async typeAsWritten(characters: readonly string[], signal?: AbortSignal): Promise<boolean> {
    if (!this.target.traits.cdp) return false;
    const held = this.state.modifiers();
    await this.sendCdpKeys(characters.flatMap((character) => chromiumTypedCommands(character, held)), signal);
    return true;
  }

  /** Presses one key of the contract grammar (`pressStroke`). */
  press(key: string, signal?: AbortSignal): Promise<void> {
    return this.key(pressStroke(key), signal);
  }

  /**
   * Presses, holds, or releases one key: as CDP key events on Chromium when
   * a BiDi key action cannot carry it (`chromiumKeyCommands`), else as a
   * BiDi key action. Either path sees the modifiers the other holds, and a
   * key is released the way it was pressed.
   */
  key(stroke: KeyStroke, signal?: AbortSignal): Promise<void> {
    const state = this.state;
    const modifiers = state.modifiers();
    if (this.target.traits.cdp) {
      const pressed = new Set([...state.keys].filter(([, held]) => held.via === 'cdp').map(([code]) => code));
      const commands = chromiumKeyCommands(stroke, { held: modifiers, pressed, mac: process.platform === 'darwin' });
      if (commands !== undefined) return this.sendCdpKeys(commands, signal);
    }
    return this.send([strokeSource(stroke, modifiers.has('Shift'))], signal);
  }

  /** Turns Chromium's drag interception on or off (`Input.setInterceptDrags`). */
  async interceptDrags(enabled: boolean): Promise<void> {
    await (await this.cdp()).send('Input.setInterceptDrags', { enabled });
  }

  /** Listens for the drag Chromium intercepted, with the data the page set; returns the unsubscribe. */
  async onDragIntercepted(handler: (data: Protocol.Input.DragData) => void): Promise<() => void> {
    return (await this.cdp()).on('Input.dragIntercepted', (event) => handler(event.data));
  }

  /** Dispatches one event of an intercepted drag at a viewport point (`Input.dispatchDragEvent`); the drag pointer is there after it. */
  async dragEvent(type: Protocol.Input.DispatchDragEventRequest['type'], point: ViewportPoint, data: Protocol.Input.DragData, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.checkInViewport([point]);
    const state = this.state;
    const cdp = await this.cdp();
    this.count();
    await cdp.send('Input.dispatchDragEvent', { type, x: point.x, y: point.y, data });
    state.pointer = { x: point.x, y: point.y };
  }

  /**
   * Sends CDP key commands to the tab's target in order, recording the keys
   * each leaves held. Nothing is sent once `signal` aborted; once the first
   * went out the rest follow, so a chord never leaves a modifier held.
   */
  private async sendCdpKeys(commands: readonly CdpKeyCommand[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const state = this.state;
    const cdp = await this.cdp();
    signal?.throwIfAborted();
    this.count();
    for (const command of commands) {
      await cdp.send(command.method, command.params);
      const held = holdsAfter(command);
      if (held?.down === true) state.keys.set(held.code, { via: 'cdp' });
      else if (held?.down === false) state.keys.delete(held.code);
    }
  }

  /** CDP on the tab's target, one session per tab. */
  private cdp(): Promise<ChromiumCdp> {
    const context = this.target.context();
    if (this.cdpSession?.context !== context) {
      const cdp = ChromiumCdp.forContext(this.target.connection, context);
      this.cdpSession = { context, cdp };
      cdp.catch(() => {
        if (this.cdpSession?.cdp === cdp) this.cdpSession = undefined;
      });
    }
    return this.cdpSession.cdp;
  }

  /**
   * The tab the sources go to, the sources as they go out, that tab's state
   * they were read against, and what they leave of it (`after`) once the
   * browser took them; refuses a pointer target outside the viewport. Keys
   * go to a tab that holds the browser's focus (`holdFocus`), a pointer to
   * one that shows a frame where the browser needs it (`framePresented`).
   */
  private async prepare(actions: readonly Input.SourceActions[], signal: AbortSignal | undefined): Promise<{ context: string; sent: Input.SourceActions[]; state: InputState; after: InputState }> {
    signal?.throwIfAborted();
    this.target.context();
    await this.checkInViewport(actions.flatMap(targets));
    const keysOnly = actions.every((source) => source.type === 'key');
    if (keysOnly) await this.holdFocus();
    else if (this.target.traits.pointerWaitsForFrame) await this.framePresented();
    signal?.throwIfAborted();
    const context = this.target.context();
    const state = this.stateOf(context);
    const after = state.copy();
    const sent = actions.map((source) => (source.type === 'key' ? keepHeld(source, after) : source.type === 'pointer' ? withPressure(source, after) : source));
    return { context, sent, state, after };
  }

  /**
   * Resolves once the tab is the one its window shows and its document has
   * rendered a frame, when it renders any. Firefox turns a mouse or wheel
   * action into a native event the parent process hit-tests against what the
   * compositor shows
   * (`remote.events.async.mouse.enabled`, `remote.events.async.wheel.enabled`):
   * a tab the app opened in front of the test's would take it, and a
   * document a navigation just moved into a new content process has shown
   * nothing yet, so input sent before its first frame reaches no page. A
   * hidden tab is brought to the front and the frame it renders there is
   * awaited, as is the frame of the document that replaced one a navigation
   * took away under the wait. Its answer is no gate: a tab still hidden at
   * the front is the shown tab of a minimized window, which renders no frame
   * and still takes the input, so refusing it would fail every pointer
   * action there.
   */
  private async framePresented(): Promise<void> {
    const { connection } = this.target;
    const context = this.target.context();
    if (await unlessStale(callFunction(connection, context, nextFrame, [], { awaitPromise: true }), false) === true) return;
    await connection.send('browsingContext.activate', { context });
    await callFunction(connection, context, nextFrame, [], { awaitPromise: true });
  }

  /** Sends sources to the tab `context`. */
  private async perform(context: string, actions: Input.SourceActions[]): Promise<void> {
    await this.target.connection.send('input.performActions', { context, actions });
  }

  /**
   * Refuses a pointer target outside the viewport as WebDriver bounds it,
   * from 0 to its width and height inclusive, before any input goes out:
   * BiDi cannot move the pointer off the page, and the browsers differ on
   * what they reject.
   */
  private async checkInViewport(points: readonly ViewportPoint[]): Promise<void> {
    if (points.length === 0) return;
    const { width, height } = await this.target.viewport();
    const outside = points.find(({ x, y }) => x < 0 || y < 0 || x > width || y > height);
    if (outside !== undefined) {
      throw new TestError('INVALID_ARGUMENT', `the pointer target (${String(outside.x)}, ${String(outside.y)}) is outside the ${String(width)}x${String(height)} viewport; WebDriver BiDi moves the pointer only within it`);
    }
  }
}

/** The viewport points a source moves the pointer to or wheels at. */
function targets(source: Input.SourceActions): ViewportPoint[] {
  if (source.type === 'pointer') return source.actions.flatMap((action) => (action.type === 'pointerMove' ? [{ x: action.x, y: action.y }] : []));
  if (source.type === 'wheel') return source.actions.flatMap((action) => (action.type === 'scroll' ? [{ x: action.x, y: action.y }] : []));
  return [];
}

/**
 * A key source with the modifiers already held left alone, so one a
 * `keyboard.down` holds stays held through a chord or a modifier click, and
 * each release sent with the value its key was pressed with; a press or
 * release left out becomes a pause, so the source keeps its ticks beside a
 * pointer's. Records in `state` what stays held after it.
 */
function keepHeld(source: Input.KeySourceActions, state: InputState): Input.KeySourceActions {
  const skipped = new Set<string>();
  const kept = source.actions.map((action): Input.KeySourceAction => {
    if (action.type !== 'keyDown' && action.type !== 'keyUp') return action;
    const code = codeOfValue(action.value);
    const held = state.keys.get(code);
    if (action.type === 'keyDown') {
      if (MODIFIER_CODES.has(code) && held !== undefined) {
        skipped.add(code);
        return { type: 'pause' };
      }
      state.keys.set(code, { via: 'bidi', value: action.value });
      return action;
    }
    if (skipped.has(code)) return { type: 'pause' };
    state.keys.delete(code);
    return held?.via === 'bidi' ? { type: 'keyUp', value: held.value } : action;
  });
  return { ...source, actions: kept };
}

/**
 * A mouse source with the pressure a held button gives: 0.5 on a press and
 * on every move while a button is down, as a real mouse reports it, so a
 * page reading `PointerEvent.pressure` sees the same. Records in `state`
 * which buttons stay held and where the mouse ends.
 */
function withPressure(source: Input.PointerSourceActions, state: InputState): Input.PointerSourceActions {
  const actions = source.actions.map((action): Input.PointerSourceAction => {
    if (action.type === 'pointerDown') {
      state.buttons.add(action.button);
      return { pressure: 0.5, ...action };
    }
    if (action.type === 'pointerUp') state.buttons.delete(action.button);
    if (action.type !== 'pointerMove') return action;
    state.pointer = { x: action.x, y: action.y };
    return state.buttons.size > 0 ? { pressure: 0.5, ...action } : action;
  });
  return { ...source, actions };
}
