/**
 * One attempt: the tabs it opens and the one it shows, and what is scoped
 * to it, each in a module of its own (its user context, page calls, refs,
 * frames, input, network, downloads, dialogs, video, artifact paths), with
 * how the attempt opens, replaces, and closes them together.
 */

import { EngineError, withTimeout, type AppLogEntry, type EngineSnapshot, type ViewportSize } from '@e2e-dev/core/engine';
import { DialogRouter } from './dialogs.ts';
import type { WebScreencastOptions } from '../options.ts';
import type { ProtectedApp } from '../protected-app.ts';
import { BidiInput } from './input.ts';
import { ChromiumCdp } from './cdp.ts';
import { ArtifactPaths } from './artifact-paths.ts';
import type { ContextTree } from './context-tree.ts';
import { AttemptDownloads, type RemoteDownloads } from './downloads.ts';
import { ErrorLatch, invalidState, releaseQuietly, unlessStale } from '../errors.ts';
import { AttemptLog } from './events.ts';
import { FrameRegistry, scriptedContexts } from './frames.ts';
import type { BidiBrowser } from './launch.ts';
import { AttemptNetwork } from './network.ts';
import { OwnNavigations } from './own-navigations.ts';
import { PageCalls } from './page-calls.ts';
import { BidiRefs } from './refs.ts';
import { foundTabs } from './found-tabs.ts';
import { AttemptTabs, type AttemptTab } from './tabs.ts';
import { acrossNavigations, tabClosed, TabWindows } from './tab-windows.ts';
import { AttemptUserContext, type UserContextSettings } from './user-context.ts';
import { viewportSize } from '../in-page/document.ts';
import { BidiVideo } from './video.ts';
import { ProviderVideo } from './provider-video.ts';
import type { AttemptVideo } from './attempt-video.ts';
import type { LeaseRecording } from '../provider.ts';
import type { BidiConnection } from './connection.ts';
import type { PageArgument, PageValue } from './script.ts';

/** How long one step of closing an attempt may take before the next runs. */
const CLOSE_STEP_MS = 10_000;

/** What every attempt of a worker is configured with. */
export interface SessionSettings extends UserContextSettings {
  readonly viewport: ViewportSize | null;
  readonly screencast: WebScreencastOptions;
  readonly testIdAttribute: string;
  readonly site: string | undefined;
  readonly projectRoot: string;
  /** Whether the browser runs on another machine (a provider's lease), whose filesystem local paths do not reach. */
  readonly remoteFiles: boolean;
  /** The run's environment, which names the tools the driver spawns (ffmpeg). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** What one attempt starts with. */
export interface AttemptSettings {
  readonly artifactsDir: string;
  readonly appLog: (entry: AppLogEntry) => void;
  /** Tells the trace where the app went on its own. */
  readonly navigation: (line: string) => void;
  /** Hands the trace a screen read after an action; absent when the attempt keeps no trace. */
  readonly screen: ((snapshot: EngineSnapshot) => void) | undefined;
  /** The configured headers and the basic-auth credentials the attempt reaches a protected app with. */
  readonly protectedApp: ProtectedApp;
  /** How downloads are read back off a remote browser's disk, or why none can be (`BrowserSource.downloads`); undefined for a local browser. */
  readonly remoteDownloads?: RemoteDownloads | undefined;
  /** How the browser's provider records the attempt, in place of the driver's own recording (`BrowserSource.recorder`); undefined when it records none. */
  readonly recorder: ((signal: AbortSignal) => Promise<LeaseRecording>) | undefined;
}

/**
 * One attempt on a BiDi browser: its tabs and the one it shows, and the user
 * context, page calls, refs, frames, network, downloads, dialogs, video, and
 * artifact paths scoped to it.
 */
export class BidiSession {
  /** The user context the attempt runs in, with what is scoped to it. */
  readonly userContext: AttemptUserContext;
  /** The attempt's open tabs, in the order they opened. */
  readonly tabs: AttemptTabs;
  /** The attempt's keyboard and mouse, the only sender of input, with what it left held in each tab. */
  readonly input: BidiInput;
  /** The calls into the attempt's documents: page functions, and the readers each document keeps. */
  readonly page: PageCalls;
  /** The node refs the attempt minted, each with the element behind it. */
  readonly refs = new BidiRefs(() => this.input.dispatches);
  readonly frames = new FrameRegistry((frame) => this.page.reader('frameBox', [frame.element], frame.context));
  readonly latch = new ErrorLatch();
  readonly dialogs = new DialogRouter(this.latch);
  readonly network: AttemptNetwork;
  readonly downloads: AttemptDownloads;
  /** The attempt's recording: the provider's when it records the browser, else the driver's own. */
  readonly video: AttemptVideo;
  /** The navigations the driver itself has in flight in the tab. */
  readonly navigations = new OwnNavigations();
  /** The attempt's subscriptions to what its pages log. */
  readonly log: AttemptLog;
  /** Where the attempt's screenshots and downloads are written. */
  readonly artifacts: ArtifactPaths;
  /** The viewport `browser.setViewport` set for the rest of the attempt; the configured one until then. */
  private viewport: ViewportSize | null;
  /** The windows of the attempt's tabs, each grown to hold its tab's viewport where a window cuts one short. */
  private readonly windows: TabWindows;
  /** The attempt's first tab while it opens in the user context in use, which concurrent first uses share. */
  private creating: Promise<AttemptTab> | undefined;
  /** The tab the attempt found open and adopted (`foundTabs`), which it never closes. */
  private adopted: string | undefined;
  /** What was open in the user context when the attempt first looked for a tab to adopt there: the browser's own, which a restart leaves open. Undefined until then, and for an attempt that adopts none. */
  private found: readonly string[] | undefined;
  private readonly ended = new AbortController();

  constructor(
    readonly browser: BidiBrowser,
    readonly settings: SessionSettings,
    readonly attempt: AttemptSettings,
    private readonly contexts: ContextTree,
  ) {
    this.artifacts = new ArtifactPaths(attempt.artifactsDir);
    this.log = new AttemptLog(browser.connection, browser.traits);
    this.page = new PageCalls(browser.connection, () => this.requireContext(), browser.traits);
    this.viewport = settings.viewport;
    this.windows = new TabWindows(browser.connection);
    this.input = new BidiInput({ connection: browser.connection, traits: browser.traits, context: () => this.requireContext(), viewport: () => this.viewportSize() });
    this.network = new AttemptNetwork(browser.connection, {
      protectedApp: attempt.protectedApp,
      ours: (event) => this.owns(event.context),
      onPage: (context) => this.onPage(context),
      contexts,
      exclusive: browser.exclusive,
      traits: browser.traits,
      onFailure: (error) => this.latch.latch(error),
      onNavigationAbort: (context, url) => {
        if (context === this.context) this.navigations.aborted(url);
      },
      lifetime: this.lifetime,
    });
    this.downloads = new AttemptDownloads(browser.connection, attempt.remoteDownloads, this.artifacts, (context) => this.onPage(context));
    this.userContext = new AttemptUserContext({
      connection: browser.connection,
      traits: browser.traits,
      settings,
      protectedApp: attempt.protectedApp,
      downloads: this.downloads,
      lifetime: this.lifetime,
    });
    this.video = attempt.recorder === undefined
      ? new BidiVideo(browser.connection, browser.traits, attempt.artifactsDir, settings.screencast, settings.env, { shown: () => this.context, viewport: () => this.viewportSize() })
      : new ProviderVideo(attempt.recorder, attempt.artifactsDir, this.lifetime);
    this.tabs = new AttemptTabs({
      prepare: async (context, front) => {
        if (this.viewport !== null) await this.sizeTab(context, this.viewport);
        if (front) await this.connection.send('browsingContext.activate', { context });
      },
      gone: (context) => tabClosed(this.connection, context),
      forget: () => {
        this.refs.clear();
        this.frames.clear();
      },
      record: async (context, closed) => {
        if (closed) await this.video.contextClosed();
        if (context !== undefined) await this.video.contextOpened(context);
      },
      close: async (context) => {
        await this.connection.send('browsingContext.close', { context });
      },
      failed: (error) => this.latch.latch(error),
    });
  }

  /** Aborts when the attempt closes, ending work it started that nothing awaits any more. */
  get lifetime(): AbortSignal {
    return this.ended.signal;
  }

  /** The browser's BiDi connection. */
  get connection(): BidiConnection {
    return this.browser.connection;
  }

  /** The tab the attempt shows, which every read and action is on. */
  get context(): string | undefined {
    return this.tabs.active()?.context;
  }

  /** Whether `context` belongs to this attempt's user context. */
  owns(context: string | null | undefined): boolean {
    return context != null && this.contexts.owner(context) === this.userContext.id;
  }

  /** Whether `context` is the attempt's tab or a frame in it: what a page-scoped wait listens to, not a tab the app opened. */
  onPage(context: string | null | undefined): boolean {
    return context != null && this.context !== undefined && this.contexts.top(context) === this.context;
  }

  /**
   * Sets up the attempt's first user context, binds the network to it, and,
   * when the attempt adopts the open tab, reads that tab before anything
   * navigates. `signal` aborting, or `close`, before it lands removes it.
   */
  async openUserContext(signal: AbortSignal): Promise<void> {
    await this.userContext.open(signal);
    await this.network.bind(this.userContext.id);
    if (this.settings.userContext === 'adopt-tab') await this.ensureContext();
  }

  /**
   * Replaces the user context with a clean one, the test's routes and added
   * init scripts carried over (`AttemptUserContext.replace`). Once the new
   * one is in use, the tabs of the old one are released and the network
   * binds to the new one, before the old one is removed; a first tab still
   * opening in the old one is no longer shared, so the next first use opens
   * its own. One whose `signal` aborted, or that a later replacement or
   * `close` overtook, leaves all of that as it was.
   */
  async replaceUserContext(signal: AbortSignal): Promise<void> {
    await this.userContext.replace(signal, async () => {
      this.creating = undefined;
      await this.releaseTabs();
      await this.network.bind(this.userContext.id);
    });
  }

  /** Releases the attempt's tabs and removes its user context with its preload scripts. */
  private async closeUserContext(): Promise<void> {
    await this.releaseTabs();
    await this.userContext.close();
  }

  /**
   * Forgets the attempt's tabs and ends the recording of the shown one. A
   * user context the attempt removes closes them with it. One that stays
   * (the browser's own) closes none, so every tab the attempt has open
   * there is closed here, whichever is shown: its own, and the ones the app
   * opened from them, a tab that has yet to join (one still loading, or
   * whose only navigation got no document) with the rest
   * (`AttemptTabs.contexts`), as a restart closes them (`replaceTabs`). The
   * tab it adopted stays open.
   */
  private async releaseTabs(): Promise<void> {
    const opened = this.tabs.contexts().filter((context) => context !== this.adopted);
    await this.forgetTabs();
    if (this.settings.userContext === 'fresh') return;
    await Promise.all(opened.map((context) => releaseQuietly(this.connection.send('browsingContext.close', { context }))));
  }

  /**
   * Forgets every tab of the attempt at once, with the refs and frames of
   * the shown one (`TabHost.forget`), then ends the recording while its tab
   * can still flush it. The tabs are about to close: a failure between this
   * and their close must not keep them open.
   */
  private async forgetTabs(): Promise<void> {
    this.tabs.clear();
    await this.video.contextClosing();
  }

  /** The attempt's tab; `INVALID_STATE` before the first open. */
  requireContext(): string {
    if (this.context === undefined) throw invalidState('no app page is open; call app.open() or browser.goto() first');
    return this.context;
  }

  /**
   * The attempt's tab, opened on first use at the attempt's viewport, with
   * the network covering it and a video segment started when recording.
   */
  async ensureContext(): Promise<string> {
    return this.context ?? (await this.firstTab()).context;
  }

  /** The attempt's first tab, which concurrent first uses open once. */
  private firstTab(): Promise<AttemptTab> {
    const opening: Promise<AttemptTab> = this.creating ??= this.createContext().finally(() => {
      if (this.creating === opening) this.creating = undefined;
    });
    return opening;
  }

  /**
   * Opens the attempt's tab in its user context, or, when the settings ask
   * for it, adopts the tab a person sees there (`adoptTab`).
   */
  private async createContext(): Promise<AttemptTab> {
    const userContext = this.userContext.id;
    if (userContext === '') throw invalidState('the attempt has no user context to open a tab in');
    this.adopted = this.settings.userContext === 'adopt-tab' ? await this.adoptTab(userContext) : undefined;
    return this.openTab(userContext, this.adopted);
  }

  /**
   * The tab a person sees in `userContext` (`foundTabs`), for the attempt
   * to adopt; undefined when none is open. What the first read finds open
   * is the browser's own (`found`). The documents the tab already shows
   * were open before the attempt had a say in them, so each is given what a
   * document that loads under the attempt gets as it starts: its origin is
   * visited, which grants it the configured permissions
   * (`AttemptUserContext.visit`), and the driver's own preloads are run in
   * it (`AttemptUserContext.prepareOpen`).
   */
  private async adoptTab(userContext: string): Promise<string | undefined> {
    const { shown, all } = await foundTabs(this.connection, userContext, this.adopted);
    this.found ??= all;
    if (shown === undefined) return undefined;
    const documents = await this.documents(shown);
    await Promise.all([
      ...documents.map((document) => this.userContext.visit(document.url)),
      scriptedContexts(this.connection, documents.map((document) => document.context)).then((callable) => this.userContext.prepareOpen(callable)),
    ]);
    return shown;
  }

  /**
   * Opens a tab in `userContext` and shows it: `adopted`, the tab the
   * attempt found open there, else a new one. The network covers it, its
   * page behaves as focused (`BidiInput.emulateFocus`, for the adopted one
   * until the attempt ends: `focusAdopted`), and its log is
   * heard (`AttemptLog.openedTab`), before it joins the attempt's tabs,
   * which show it (`AttemptTabs.own`). Until
   * it is shown a tab created here is this call's to close: when a step
   * fails, or the attempt closed or replaced its user context while the tab
   * opened, it is closed again, and an adopted one is left as it was found.
   * The user context is checked in the step the tab joins in, so a tab of
   * one the attempt left never joins its tabs.
   */
  private async openTab(userContext: string, adopted: string | undefined): Promise<AttemptTab> {
    const connection = this.connection;
    const context = adopted ?? (await connection.send('browsingContext.create', { type: this.browser.traits.newContext, userContext })).context;
    try {
      this.requireUserContext(userContext);
      await this.network.addContext(context);
      if (context === adopted) await this.focusAdopted(context);
      else await this.input.emulateFocus(context);
      await this.log.openedTab(userContext, context, context === adopted);
      this.requireUserContext(userContext);
      return await this.tabs.own(context);
    } catch (cause) {
      if (context !== adopted) await releaseQuietly(connection.send('browsingContext.close', { context }));
      throw cause;
    }
  }

  /**
   * Has the page of the tab the attempt adopted behave as focused
   * (`BidiInput.emulateFocus`) for as long as the attempt runs. The tab
   * outlives the attempt, and a page told to behave as focused also reads as
   * visible in a background tab, which is how the next attempt tells the tab
   * a person sees (`foundTabs`). So where the browser emulates focus per tab
   * (`BrowserTraits.focus`), the tab holds focus as its window gives it again
   * when the attempt ends, unless it closed first.
   */
  private async focusAdopted(context: string): Promise<void> {
    const emulate = (): Promise<void> => this.input.emulateFocus(context);
    if (this.browser.traits.focus !== 'emulated') return emulate();
    await this.userContext.set('focus', emulate, () => unlessStale(
      ChromiumCdp.forContext(this.connection, context).then((cdp) => cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false })),
      undefined,
    ));
  }

  /**
   * Fails `NODE_STALE` once the attempt closed, or replaced or removed
   * `userContext`, while a tab opened in it: the tab is none of the
   * attempt's any more.
   */
  private requireUserContext(userContext: string): void {
    if (userContext === this.userContext.id && !this.lifetime.aborted) return;
    throw new EngineError('NODE_STALE', 'the attempt replaced its user context while a tab opened', { retryable: true });
  }

  /**
   * Opens a blank tab in the attempt's user context, sharing its cookies
   * and storage, and shows it (`browser.newTab`); before the attempt has a
   * tab, that is its own.
   */
  newTab(): Promise<AttemptTab> {
    return this.context === undefined ? this.firstTab() : this.openTab(this.userContext.id, undefined);
  }

  /**
   * Runs a read of the shown tab. A tab that closes under the read makes it
   * stale, as a navigation does: nothing was dispatched, and the read
   * repeats on the tab shown next. `read` is told the tab it reads.
   */
  async readTab<T>(read: (tab: AttemptTab | undefined) => Promise<T>): Promise<T> {
    const tab = this.tabs.active();
    try {
      return await read(tab);
    } catch (cause) {
      if (tab !== undefined && (await this.tabGone(tab).catch(() => false))) {
        throw new EngineError('NODE_STALE', 'the tab closed while it was read', { retryable: true, cause });
      }
      throw cause;
    }
  }

  /** Whether `tab` has closed, asking the browser when no event has told it yet. */
  async tabGone(tab: AttemptTab): Promise<boolean> {
    return tab.closed || (await tabClosed(this.connection, tab.context));
  }

  /**
   * Resizes the shown tab, and every tab shown after it, to `size`. A size
   * the tab cannot take (`sizeTab`) fails and leaves the viewport as it was.
   */
  async setViewport(size: ViewportSize): Promise<void> {
    const viewport = { width: size.width, height: size.height };
    // Before the first page the size is only kept: the tab opens at it, and no page opens early.
    if (this.context !== undefined) await this.sizeTab(this.context, viewport);
    this.viewport = viewport;
  }

  /**
   * Gives a tab the attempt's viewport at scale factor 1, whatever the
   * display's, so a headed run on a dense display renders the pixels a
   * headless one does. Where the tab's window would cut the viewport short
   * (`BrowserTraits.windowClipsViewport`) the window grows to hold it first,
   * and a viewport no window can hold fails `UNSUPPORTED_CAPABILITY` with
   * the tab as it was. The viewport is the tab's, whatever document it
   * shows, so a tab that navigates while it is sized gets it all the same
   * (`acrossNavigations`). The tab the attempt adopted outlives it, so it
   * gets the size its window gives it back when the attempt ends
   * (`AttemptUserContext.set`), unless it closed first.
   */
  private async sizeTab(context: string, viewport: ViewportSize): Promise<void> {
    if (this.browser.traits.windowClipsViewport) await this.windows.hold(context, viewport);
    const size = (): Promise<unknown> => acrossNavigations(this.connection, context, () => this.connection.send('browsingContext.setViewport', { context, viewport, devicePixelRatio: 1 }));
    if (context === this.adopted) await this.userContext.set('viewport', size, () => unlessStale(this.connection.send('browsingContext.setViewport', { context, viewport: null, devicePixelRatio: null }), undefined));
    else await size();
  }

  /**
   * Replaces every tab of the user context, the ones the app opened too,
   * with the attempt's first tab, opened again, keeping the user context's
   * storage, as a restart closes every page; the harness reopens the app.
   * The new tab opens before the old ones close, so the user context is
   * never without a tab, and a browser that exits with its last window
   * keeps running. One whose `signal` aborted before the open tabs were
   * read closes none and leaves the attempt's tabs as they were. After
   * that every one is forgotten and closed, even when the new tab cannot
   * open or the restart is given up on, which then opens none under the
   * step after it. A first tab that was open before (one still opening
   * when the restart began, the tab the attempt adopts) stays open, and so
   * does every tab the attempt found open when it adopted one (`found`).
   */
  async replaceTabs(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const { contexts } = await this.connection.send('browsingContext.getTree', { maxDepth: 0 });
    signal.throwIfAborted();
    const kept = this.found ?? [];
    const old = contexts.filter((info) => info.userContext === this.userContext.id && !kept.includes(info.context)).map((info) => info.context);
    await this.forgetTabs();
    let first: string | undefined;
    try {
      signal.throwIfAborted();
      first = (await this.firstTab()).context;
    } finally {
      await Promise.all(old.filter((context) => context !== first).map((context) => unlessStale(this.connection.send('browsingContext.close', { context }), undefined)));
    }
  }

  /** Calls a page function the test compiled (`compileEvaluation`) with `arg` and returns its whole result; the test's code may change the page, as input would. */
  evaluate(declaration: string, arg: PageArgument | undefined): Promise<PageValue> {
    this.input.mutated();
    return this.page.call(declaration, arg === undefined ? [] : [arg], { awaitPromise: true, maxObjectDepth: null });
  }

  /** The viewport in CSS pixels: the attempt's, else the window's. */
  async viewportSize(): Promise<ViewportSize> {
    if (this.viewport !== null) return this.viewport;
    return this.page.run(viewportSize, []);
  }

  /** The URL of `context` (the shown tab by default), as the browser reports it. */
  async currentUrl(context = this.requireContext()): Promise<string> {
    const { contexts } = await this.connection.send('browsingContext.getTree', { root: context, maxDepth: 0 });
    return contexts[0]?.url ?? '';
  }

  /**
   * The documents of `documentContexts` a call can be made into: one with no
   * script context yet (`hasScriptContext`) would hold the call until its
   * frame's first navigation commits.
   */
  async callableDocuments(context: string): Promise<string[]> {
    return scriptedContexts(this.connection, await this.documentContexts(context));
  }

  /** `context` and every frame document under it. */
  async documentContexts(context: string): Promise<string[]> {
    return (await this.documents(context)).map((document) => document.context);
  }

  /** `context` and every frame document under it, each with the URL the browser names for it, from one read of the tree. */
  private async documents(context: string): Promise<{ readonly context: string; readonly url: string }[]> {
    const { contexts } = await this.connection.send('browsingContext.getTree', { root: context });
    const out: { readonly context: string; readonly url: string }[] = [];
    const walk = (info: (typeof contexts)[number]): void => {
      out.push({ context: info.context, url: info.url });
      for (const child of info.children ?? []) walk(child);
    };
    for (const info of contexts) walk(info);
    return out;
  }

  /**
   * Ends the attempt: its video, user context, log subscriptions (once its
   * tabs are gone: a browser asks a page to stop reporting, and a stuck one
   * never answers), network, and download directory, each attempted
   * whatever the others did; the first failure is
   * reported once all ran, each remote step bounded so a hung one never keeps
   * the rest from running. A browser already gone leaves only local work. A
   * replacement user context still opening removes itself when it lands.
   */
  async close(): Promise<void> {
    this.ended.abort();
    const gone = this.connection.isClosed;
    const step = (label: string, work: () => unknown): (() => Promise<unknown>) => () =>
      withTimeout(Promise.resolve().then(work), CLOSE_STEP_MS, () => new EngineError('OPERATION_TIMEOUT', `${label} did not finish within ${CLOSE_STEP_MS}ms`, { retryable: false }));
    const results = await settleEach([
      step(this.video.closeStep, () => this.video.close(CLOSE_STEP_MS)),
      step('user context removal', () => (gone ? undefined : this.closeUserContext())),
      step('earlier user contexts', () => (gone ? undefined : this.userContext.removeOwed())),
      step('log release', () => (gone ? undefined : this.log.close())),
      step('network release', () => this.network.dispose()),
      () => this.downloads.dispose(),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }
}

/** Runs each step in order whatever the earlier ones did, and settles with every outcome. */
async function settleEach(steps: readonly (() => unknown)[]): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = [];
  for (const step of steps) {
    try {
      results.push({ status: 'fulfilled', value: await step() });
    } catch (reason) {
      results.push({ status: 'rejected', reason });
    }
  }
  return results;
}
