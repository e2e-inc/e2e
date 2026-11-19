/**
 * Launches a local browser, or attaches to a remote Chromium, and opens a
 * WebDriver BiDi session on it. Firefox speaks BiDi natively over a
 * WebSocket; Chromium speaks CDP, so the `chromium-bidi` mapper translates,
 * in a child process (`mapper-transport.ts`). Local launches run the pinned
 * builds `install/provision.ts` keeps in the browsers cache, with the flags
 * in `launch-flags.ts`, under a watchdog (`browser-watchdog.ts`).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineError, raceAbort, withTimeout } from '@e2e-dev/core/engine';
import { BROWSER_TRAITS, type BrowserName, type BrowserTraits } from '../browsers.ts';
import { endpointLine, spawnWatched, stopped, type Watchdog } from './browser-watchdog.ts';
import { ChromiumCdp } from './cdp.ts';
import { abortError, message, releaseQuietly } from '../errors.ts';
import { chromiumArgs, firefoxArgs } from './launch-flags.ts';
import { chromiumMapper } from './mapper-transport.ts';
import type { CdpTarget, WebMedia } from '../options.ts';
import { BidiConnection, type BidiTransport, webSocketTransport } from './connection.ts';
import { browserExecutable } from '../install/provision.ts';

/** One launched browser with its open BiDi session. */
export interface BidiBrowser {
  /** What the driver does differently on this browser. */
  readonly traits: BrowserTraits;
  /** The browser's version, as the session reports it. */
  readonly version: string;
  readonly connection: BidiConnection;
  /** Whether no other client drives this browser: a launch is, a browser attached over CDP may not be. */
  readonly exclusive: boolean;
  /** Ends the session; a launched browser's process is killed and its profile removed, an attached one is left running. */
  close(): Promise<void>;
}

/** How to launch a browser for the BiDi driver. */
export interface BidiLaunchOptions {
  readonly headed: boolean;
  /** How long each stage of the launch may take. */
  readonly timeoutMs: number;
  /** The run's environment, which names the browsers cache the pinned build is in. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Kills the browser and fails the launch at any stage: `CANCELLED`, or the deadline it aborted with. */
  readonly signal: AbortSignal;
  /** The media features the run sets for every page, for a browser that takes one of them only at launch. */
  readonly media: WebMedia;
}

const FIREFOX_ENDPOINT = /WebDriver BiDi listening on (ws:\/\/\S+)/;
const CHROMIUM_ENDPOINT = /DevTools listening on (ws:\/\/\S+)/;

/** How one browser is launched: its arguments on a fresh profile, and the BiDi transport to it once it listens. */
interface Launcher {
  /** The browser's arguments on `profile`, which Firefox's preferences are written into. */
  args(profile: string, options: BidiLaunchOptions): string[];
  /** Waits for the endpoint `watchdog`'s browser prints and connects to it; `signal` aborting stops the wait. */
  transport(watchdog: Watchdog, timeoutMs: number, signal: AbortSignal): Promise<BidiTransport>;
}

/** Every browser's launcher: Firefox serves BiDi on a WebSocket of its own, Chromium through the mapper. */
const LAUNCHERS: Readonly<Record<BrowserName, Launcher>> = {
  chromium: {
    args: (profile, options) => chromiumArgs(profile, options.headed),
    transport: (watchdog, timeoutMs, signal) => chromiumMapper(endpointLine(watchdog, CHROMIUM_ENDPOINT, timeoutMs).then((url) => ({ url })), timeoutMs, signal),
  },
  firefox: {
    args: (profile, options) => firefoxArgs(profile, options.headed, options.media),
    transport: (watchdog, timeoutMs, signal) =>
      raceAbort(async () => webSocketTransport(`${await endpointLine(watchdog, FIREFOX_ENDPOINT, timeoutMs)}/session`, timeoutMs), signal, 'BiDi firefox launch'),
  },
};

/**
 * Launches `name` and opens a BiDi session, each stage bounded by
 * `options.timeoutMs`. The browser runs under a watchdog process
 * (`browser-watchdog.ts`) that kills it and removes its profile once this
 * process lets go of it, however this process ends. `signal` aborting at any
 * stage kills the browser and the mapper and fails the launch `CANCELLED`,
 * or with the deadline it aborted with (`abortError`).
 */
export async function launchBidiBrowser(name: BrowserName, options: BidiLaunchOptions): Promise<BidiBrowser> {
  const { signal, timeoutMs } = options;
  const what = `BiDi ${name} launch`;
  if (signal.aborted) throw abortError(signal, what);
  const executable = browserExecutable(name, options.headed, options.env);
  const profile = mkdtempSync(path.join(os.tmpdir(), `e2e-bidi-${name}-`));
  const failure = (cause: unknown): EngineError => launchFailure(`${what} failed`, cause);
  let watchdog: Watchdog;
  try {
    watchdog = spawnWatched(profile, executable, LAUNCHERS[name].args(profile, options));
  } catch (cause) {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    throw failure(cause);
  }
  return open({ what, failure, traits: BROWSER_TRAITS[name], transport: () => LAUNCHERS[name].transport(watchdog, timeoutMs, signal), owned: watchdog, timeoutMs, signal });
}

/**
 * Attaches to a running Chromium over CDP (a `ws://` DevTools URL, or the
 * `http://` endpoint that names one) through the mapper, the way a hosted
 * browser is reached. Closing ends the session and leaves the browser to its
 * host. `signal` aborting at any stage (the endpoint fetch, the mapper start,
 * the session) stops the attach and fails it `CANCELLED`, or with the
 * deadline it aborted with (`abortError`).
 */
export async function connectBidiOverCdp(target: CdpTarget, timeoutMs: number, signal: AbortSignal): Promise<BidiBrowser> {
  const what = 'BiDi attach over CDP';
  if (signal.aborted) throw abortError(signal, what);
  return open({
    what,
    // A failed handshake can echo its credentials in altered forms, so with headers only the kind of failure is kept.
    failure: (cause) =>
      target.headers === undefined
        ? launchFailure(`${what} failed`, cause)
        : new EngineError('ENGINE_FAILURE', `${what} failed; check the endpoint, handshake headers, and connection timeout`, { retryable: false }),
    traits: BROWSER_TRAITS.chromium,
    transport: () => chromiumMapper(webSocketDebuggerUrl(target, timeoutMs, signal).then((url) => ({ url, headers: target.headers })), timeoutMs, signal),
    owned: undefined,
    timeoutMs,
    signal,
  });
}

/** What `open` opens a session on, and how its outcome is reported. */
interface BidiOpen {
  /** What is being done, as its cancellation names it: `BiDi chromium launch`. */
  readonly what: string;
  /** The error a failure is reported as, unless `signal` aborted. */
  readonly failure: (cause: unknown) => EngineError;
  readonly traits: BrowserTraits;
  /** Connects the BiDi transport to the browser, once it listens. */
  readonly transport: () => Promise<BidiTransport>;
  /** The watchdog of a browser this process launched, which a close or a failure stops; undefined for a browser attached to, which is left running. */
  readonly owned: Watchdog | undefined;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** How long a closing session waits for the browser to answer its goodbye before the connection is dropped anyway. */
const GOODBYE_MS = 2_000;

/**
 * Connects to a browser and opens its BiDi session, the tail of a launch and
 * of an attach. A failure or `signal` aborting at any stage closes the
 * connection and stops an owned browser.
 */
async function open(spec: BidiOpen): Promise<BidiBrowser> {
  const { traits, owned, timeoutMs, signal } = spec;
  let connection: BidiConnection | undefined;
  try {
    connection = new BidiConnection(await spec.transport());
    const opened = connection;
    const version = await openSession(opened, traits, timeoutMs, signal);
    return {
      traits,
      version,
      connection: opened,
      exclusive: owned !== undefined,
      close: async () => {
        await releaseQuietly(withTimeout(opened.send(owned === undefined ? 'session.end' : 'browser.close', {}), GOODBYE_MS, () => new Error('the browser did not answer its goodbye')));
        opened.close();
        if (owned !== undefined) await stopped(owned);
      },
    };
  } catch (cause) {
    connection?.close();
    if (owned !== undefined) await stopped(owned);
    if (signal.aborted) throw abortError(signal, spec.what);
    throw spec.failure(cause);
  }
}

/** A launch or attach failure as the engine reports it: a classified error passes, anything else names what failed. */
function launchFailure(what: string, cause: unknown): EngineError {
  if (cause instanceof EngineError) return cause;
  return new EngineError('ENGINE_FAILURE', `${what}: ${message(cause)}`, { retryable: false, cause });
}

/**
 * The browser-wide DevTools WebSocket URL of `endpoint`: as given for
 * `ws(s)://`, read from `json/version/` under the endpoint's path for
 * `http(s)://`, as Playwright's `connectOverCDP` reads it, sending the
 * target's handshake headers.
 */
async function webSocketDebuggerUrl({ endpoint, headers }: CdpTarget, timeoutMs: number, signal: AbortSignal): Promise<string> {
  if (/^wss?:/i.test(endpoint)) return endpoint;
  const discovery = new URL(endpoint);
  discovery.pathname = `${discovery.pathname.replace(/\/$/, '')}/json/version/`;
  const response = await fetch(discovery, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), ...(headers === undefined ? {} : { headers }) });
  const version: unknown = await response.json();
  const url = typeof version === 'object' && version !== null ? Reflect.get(version, 'webSocketDebuggerUrl') : undefined;
  if (typeof url !== 'string') throw new Error(`${endpoint}/json/version names no webSocketDebuggerUrl`);
  return url;
}

/**
 * Opens the session within `timeoutMs`, unless `signal` aborts first, and
 * returns the browser's version. A
 * user prompt stays open for the driver to route
 * (`browsingContext.userPromptOpened`), as Playwright hands each dialog to
 * its listener; a file chooser is dismissed once `input.fileDialogOpened`
 * names its input, which `input.setFiles` fills, since one left open keeps
 * Firefox from opening the input's chooser again; certificate errors fail
 * navigation, as Playwright's default `ignoreHTTPSErrors: false` does.
 */
async function openSession(connection: BidiConnection, traits: BrowserTraits, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const opened = async (): Promise<string> => {
    const session = await connection.send('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: false, unhandledPromptBehavior: { default: 'ignore', file: 'dismiss' } } } });
    return traits.cdp ? chromiumVersion(connection) : session.capabilities.browserVersion;
  };
  return withTimeout(
    raceAbort(opened(), signal, 'opening the BiDi session'),
    timeoutMs,
    () => new EngineError('ENGINE_FAILURE', `the browser opened no BiDi session within ${timeoutMs}ms`, { retryable: false }),
  );
}

/**
 * Chromium's version number, from the product CDP's `Browser.getVersion`
 * names (`HeadlessChrome/157.0.8103.38`): the mapper reports the build's
 * revision hash as `browserVersion` for the headless shell.
 */
async function chromiumVersion(connection: BidiConnection): Promise<string> {
  const { product } = await ChromiumCdp.browser(connection).send('Browser.getVersion', {});
  return product.slice(product.lastIndexOf('/') + 1);
}
