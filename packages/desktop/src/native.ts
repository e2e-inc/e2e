// Written by `node scripts/native/build-native.ts desktop` from crates/e2e-desktop-napi. Do not edit.
import type { Envelope, Launched, RawWindow } from './driver.ts';
import type { RawSnapshot } from './nodes.ts';

/** One action on the element a ref names. */
export declare function act(options: ActOptions): Promise<Envelope<unknown>>

export interface ActOptions {
  /** The ref a snapshot handed out. */
  ref: string
  /** `click`, `doubleClick`, `rightClick`, `focus`, `clear`, `check`, `uncheck`, `scrollTo`, `hover`, `setValue`, `selectAll`, `select`, `scroll`, or `type`. */
  action: string
  value?: string
  direction?: string
  pages?: number
  physical?: boolean
  /** Names this action's run, so `cancelInput` can stop it before it sends input. */
  inputId?: number
  timeoutMs: number
}

/** Stops the call (`act`, `press`, `pointer`, `launch`) that was given `inputId`: it sends no input from then on, though what it sent stays sent. */
export declare function cancelInput(inputId: number): void

/**
 * Checks that a key combo can be pressed on this Mac's keyboard layout, the way `press` reads it, and sends nothing: a
 * caller that moves focus first can refuse a combo the layout cannot type before anything changed.
 */
export declare function checkCombo(combo: string): Promise<Envelope<unknown>>

/** Closes a window as its close button does. `inputId` names it, so `cancelInput` stops it before the button is pressed. */
export declare function closeWindow(pid: number, windowIdText: string, inputId?: number | undefined | null, timeoutMs?: number | undefined | null): Promise<Envelope<unknown>>

/** Brings a window and its app forward. `inputId` names it, so `cancelInput` stops it before it changes the focus. */
export declare function focusWindow(pid: number, windowIdText: string, inputId?: number | undefined | null, timeoutMs?: number | undefined | null): Promise<Envelope<unknown>>

/** Drops the refs of a process that quit. */
export declare function forgetProcess(pid: number): void

/**
 * A fresh id for one call's input (`act`, `press`, `pointer`, `launch`), unique in the process: every Node worker
 * thread shares the addon, and with it the ids `cancelInput` reaches.
 */
export declare function inputId(): number

/** Starts a new instance of an app. */
export declare function launch(options: LaunchOptions): Promise<Envelope<Launched>>

export interface LaunchOptions {
  path?: string
  bundleId?: string
  arguments: Array<string>
  /** The whole environment the app is started with, beside launchd's own. */
  environment: Record<string, string>
  /** Marks the process the launch starts, as `E2E_DESKTOP_LAUNCH`. */
  token: string
  activate: boolean
  timeoutMs: number
  /** How long the search for the launched process may take once `open` has exited. */
  claimMs: number
  /** Names the launch, so `cancelInput` can stop it before it starts the app. */
  inputId?: number
}

/** The windows of a process. */
export declare function listWindows(pid: number): Promise<Envelope<readonly RawWindow[]>>

/**
 * Physical pointer input at a point on screen: `tap`, `doubleTap`, `secondaryTap`, or `hover`. `inputId` names it, so
 * `cancelInput` stops what it has yet to send. With `target`, no click goes once another window, a new sheet, or
 * another app took the focus from that window.
 */
export declare function pointer(x: number, y: number, kind: string, inputId?: number | undefined | null, timeoutMs?: number | undefined | null, target?: PointerTarget | undefined | null): Promise<Envelope<unknown>>

/** The window a point was taken in, which must still take the click when it goes. */
export interface PointerTarget {
  pid: number
  windowId: string
  /** Whether a sheet on the window held its focus when the point was taken. */
  sheet: boolean
  /**
   * That sheet's key, as `listWindows` gave it (`sheet_id`): another sheet in its place, or one with no key, does not
   * take the click.
   */
  sheetId?: string
  /** The point is on a node with no ref, which takes no click of its own: no control may be under it when it goes. */
  content?: boolean
}

/** Presses a key combo into a window. */
export declare function press(options: PressOptions): Promise<Envelope<unknown>>

export interface PressOptions {
  pid: number
  windowId: string
  /** A combo such as `cmd+a` or `return`. */
  combo: string
  physical: boolean
  /** A ref whose element must still hold the app's focus when the key goes: a locator's control. */
  focusedRef?: string
  /** Names this press, so `cancelInput` can stop it before it sends the key. */
  inputId?: number
  timeoutMs: number
}

/**
 * Every process that carries the launch `token`; `null` when the processes cannot be listed. It reads
 * every process, which takes tens of milliseconds, so it runs on a blocking thread, off the JavaScript thread.
 */
export declare function processesCarrying(token: string): Promise<Array<number> | null>

/** When a process started, in microseconds since the epoch; `null` when it is not running. */
export declare function processStarted(pid: number): number | null

/** Whether the screen is locked; `null` when that cannot be told. */
export declare function screenLocked(): boolean | null

/** Captures a window into a PNG file; answers the display's scale. */
export declare function screenshot(options: ScreenshotOptions): Promise<Envelope<{ readonly scale_factor?: number }>>

export interface ScreenshotOptions {
  windowId: string
  path: string
  timeoutMs: number
}

/** One window's accessibility tree. */
export declare function snapshot(options: SnapshotOptions): Promise<Envelope<RawSnapshot>>

export interface SnapshotOptions {
  pid: number
  windowId: string
  maxDepth: number
  interactive: boolean
  timeoutMs: number
}

/**
 * The permissions this process holds. The driver's version is the version of the package it ships in, which the
 * loader reads; the crate itself is never versioned.
 */
export declare function status(): Status

export interface Status {
  accessibility: boolean
  screenRecording: boolean
}
