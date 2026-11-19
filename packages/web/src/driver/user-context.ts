/**
 * The attempt's user context: the one in use, set up with everything scoped
 * to it (preload scripts, downloads, emulation, media), replaced by a clean
 * one or removed, the ones still owed removal, and what the attempt leaves
 * in the one in use: the init scripts a test added, the origins its
 * documents were at, and the permissions granted to them. A user context
 * the attempt does not remove (the browser's own) is given back as it was
 * found: everything the attempt set in it is taken back when the attempt
 * leaves it (`takeBack`).
 */

import type { Emulation } from 'webdriver-bidi-protocol';
import { EngineError, obj } from '@e2e-dev/core/engine';
import type { BrowserTraits } from '../browsers.ts';
import { abortError, BidiError, releaseQuietly, unlessStale } from '../errors.ts';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT } from '../in-page/closed-shadow.ts';
import { HIT_INTERCEPTOR_INIT_SCRIPT } from '../in-page/hit-interceptor.ts';
import { MODAL_ORDER_INIT_SCRIPT } from '../in-page/modal-dialogs.ts';
import { BUILTINS_INIT_SCRIPT, READERS_INIT_SCRIPT } from '../in-page/readers.ts';
import type { ConfiguredInitScripts } from '../init-scripts.ts';
import type { WebMedia } from '../options.ts';
import type { ProtectedApp } from '../protected-app.ts';
import type { BidiConnection } from './connection.ts';
import type { AttemptDownloads } from './downloads.ts';
import { ChromiumCdp } from './cdp.ts';
import { callFunction } from './script.ts';

/**
 * Refuses service worker registration, as Playwright's `serviceWorkers:
 * 'block'` does when headers are configured: a worker's requests bypass
 * request interception, so they would leave without the headers.
 */
const BLOCK_SERVICE_WORKERS = "if (navigator.serviceWorker) navigator.serviceWorker.register = async () => { console.warn('Service Worker registration blocked by e2e'); };";

/**
 * Which user context an attempt runs in: a fresh one it creates and
 * removes, the browser's default one (which a per-attempt lease's `prepare`
 * may have signed in), or the default one on the tab the browser shows
 * there, which the attempt adopts and leaves open (`attachBrowser`).
 */
export type UserContextMode = 'fresh' | 'default' | 'adopt-tab';

/** The browser's own user context, which a lease's `prepare` signed in and which outlives every attempt. */
const DEFAULT_USER_CONTEXT = 'default';

/** The part of a worker's settings each user context of an attempt is set up with. */
export interface UserContextSettings {
  /** The user context an attempt runs in (`BrowserSource.userContext`). */
  readonly userContext: UserContextMode;
  /** What to do with a browser that can create no user context, when the source knows (`BrowserSource.userContext`). */
  readonly withoutUserContexts: string | undefined;
  readonly initScripts: ConfiguredInitScripts;
  readonly userAgent: string | undefined;
  readonly locale: string | undefined;
  readonly timezoneId: string | undefined;
  readonly media: WebMedia;
  readonly permissions: readonly string[];
}

/** What the attempt's user contexts are set up through and with. */
export interface UserContextHost {
  readonly connection: BidiConnection;
  readonly traits: BrowserTraits;
  readonly settings: UserContextSettings;
  /** The attempt's configured headers, which a service worker's requests would leave without. */
  readonly protectedApp: ProtectedApp;
  /** The attempt's downloads, whose directory each user context saves into. */
  readonly downloads: AttemptDownloads;
  /** Aborts when the attempt closes: no user context is set up after that, and one still being set up removes itself when it lands. */
  readonly lifetime: AbortSignal;
}

/** A user context the attempt set up, with the preload scripts scoped to it. */
interface ScopedUserContext {
  readonly userContext: string;
  readonly preloads: readonly string[];
}

/** The call that takes one thing the attempt set back to how the browser had it. */
type TakeBack = () => Promise<unknown>;

/** The user context one attempt runs in, through every replacement, until the attempt's close removes it. */
export class AttemptUserContext {
  /** The web origins the attempt's documents have been at, whose storage a saved session keeps. */
  readonly visited = new Set<string>();
  private current = '';
  private preloads: string[] = [];
  /** User contexts this attempt created and has not yet seen removed, tried again by every later removal and by the attempt's close. */
  private readonly unremoved = new Set<string>();
  /**
   * Bumped by every user context the attempt starts to set up: one that
   * lands for an earlier generation (a reset a later one superseded)
   * removes itself instead of replacing the one in use.
   */
  private generation = 0;
  private readonly addedScripts: string[] = [];
  private readonly granted = new Map<string, Promise<void>>();
  /** The media features in effect: the configured ones, updated by `emulateMedia`. */
  private media: WebMedia;
  /**
   * What the attempt set in a user context it does not remove, and in the
   * tab it adopted there, each by what it is, with the call that takes it
   * back (`takeBack`). Empty in a user context of the attempt's own, whose
   * removal takes everything with it.
   */
  private readonly kept = new Map<string, TakeBack>();

  constructor(private readonly host: UserContextHost) {
    this.media = host.settings.media;
  }

  /** The user context in use; empty before the first is set up and once the attempt removed it. */
  get id(): string {
    return this.current;
  }

  /** Sets up the attempt's first user context. `signal` aborting, or the attempt closing, before it lands removes it. */
  async open(signal: AbortSignal): Promise<void> {
    await this.install(signal);
  }

  /**
   * Replaces the user context with a clean one, the added init scripts
   * carried over. The new one is set up in full before it takes the old
   * one's place in one step; `moved` then runs, for what the attempt keeps
   * per user context (its tabs, recording, and network), and only then is
   * the old one removed, so no step ever runs between the two. A `moved`
   * that fails still has the old one removed, and its own failure is the
   * one thrown. One whose `signal` aborted, or that a later replacement or
   * the attempt's close overtook, removes itself and leaves the user
   * context in use as it was.
   */
  async replace(signal: AbortSignal, moved: () => Promise<void>): Promise<void> {
    const previous = await this.install(signal);
    try {
      await moved();
    } catch (cause) {
      await releaseQuietly(this.drop(previous));
      throw cause;
    }
    await this.drop(previous);
  }

  /** Forgets the user context in use and removes it with its preload scripts. */
  async close(): Promise<void> {
    const current = { userContext: this.current, preloads: this.preloads };
    this.current = '';
    this.preloads = [];
    await this.drop(current);
  }

  /** Removes every user context still owed removal; one that fails stays owed, and the first failure is thrown. */
  async removeOwed(): Promise<void> {
    const { connection } = this.host;
    const pending = [...this.unremoved];
    const results = await Promise.allSettled(pending.map((userContext) => connection.send('browser.removeUserContext', { userContext })));
    pending.forEach((userContext, index) => {
      const result = results[index]!;
      if (result.status === 'fulfilled' || (result.reason instanceof BidiError && result.reason.error === 'no such user context')) this.unremoved.delete(userContext);
    });
    const failed = results.find((result, index) => result.status === 'rejected' && this.unremoved.has(pending[index]!));
    if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
  }

  /**
   * Sets one thing of the user context in use, or of a tab in it: runs
   * `apply`, with `takeBack` kept for when the attempt leaves a user context
   * it does not remove. `what` names the thing, so setting it again keeps
   * one call. A user context of the attempt's own keeps none: its removal
   * takes everything with it.
   */
  async set(what: string, apply: () => Promise<unknown>, takeBack: TakeBack): Promise<void> {
    if (this.host.settings.userContext !== 'fresh') this.kept.set(what, takeBack);
    await apply();
  }

  /**
   * Changes the attempt's media features from the next paint on
   * (`browser.emulateMedia`). A browser that does not emulate reduced motion
   * (Firefox overrides only `prefers-color-scheme` over BiDi) refuses a
   * reduced-motion change; `web({ reducedMotion })` still applies at launch.
   */
  async emulateMedia(media: WebMedia): Promise<void> {
    if (!this.host.traits.emulatesReducedMotion && media.reducedMotion !== undefined) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', 'browser.emulateMedia({ reducedMotion }) is not supported on Firefox, which overrides only prefers-color-scheme over WebDriver BiDi; set web({ reducedMotion }) instead', { retryable: false });
    }
    this.media = { ...this.media, ...media };
    await this.applyMedia(this.current);
  }

  /** Adds an init script for every document of this user context from now on, and of every one that replaces it. */
  async addInitScript(source: string): Promise<void> {
    const { script } = await this.host.connection.send('script.addPreloadScript', {
      functionDeclaration: wrapAppScript(source),
      userContexts: [this.current],
    });
    this.addedScripts.push(source);
    this.preloads.push(script);
  }

  /**
   * Runs the driver's own preloaded scripts (`driverScripts`) in `documents`,
   * which were open before the user context's preloads were added (the tab
   * the attempt adopts, with its frames) and run none until they navigate.
   * From here on such a document records its closed shadow roots and the
   * order of its modal dialogs, has the click watch's listeners, and keeps
   * its `Event` and builtins as they are now, as one that loaded under the
   * preloads does from its start. What happened in it earlier stays unknown:
   * a closed root already attached, dialogs already shown, a builtin the
   * page already replaced, and capture listeners the app already has on the
   * window, which stay ahead of the click watch's. A script that throws
   * there (a page that broke what it calls) leaves the rest to run, and a
   * document gone meanwhile gets the preloads with the one that replaces
   * it. An app's own init scripts are for new documents, and are not run.
   */
  async prepareOpen(documents: readonly string[]): Promise<void> {
    const source = `() => {\n${this.driverScripts().map((script) => `try {\n${script}\n} catch {}`).join('\n')}\n}`;
    await Promise.all(documents.map((context) => unlessStale(callFunction(this.host.connection, context, source), undefined)));
  }

  /**
   * The driver's own scripts for every document of the attempt, in the order
   * they run: the builtins the readers are built over first. Each does
   * nothing in a document that has run it, so one may run in a document
   * twice (`prepareOpen` beside the preload).
   */
  private driverScripts(): string[] {
    return [
      BUILTINS_INIT_SCRIPT,
      READERS_INIT_SCRIPT,
      CLOSED_SHADOW_ROOTS_INIT_SCRIPT,
      MODAL_ORDER_INIT_SCRIPT,
      HIT_INTERCEPTOR_INIT_SCRIPT,
      ...(this.host.protectedApp.sendsHeaders ? [BLOCK_SERVICE_WORKERS] : []),
    ];
  }

  /**
   * Records a document of the attempt starting to load `url`: its origin is
   * remembered for a saved session, and granted the configured permissions,
   * once per origin and user context (BiDi grants per origin). Concurrent
   * calls for one origin share its grant. A grant is an override Chromium
   * keeps beside what its user decided, and BiDi can set one but not lift
   * it, so the browser's own user context gets its permissions back over
   * CDP, which lifts every override there (`Browser.resetPermissions`).
   */
  visit(url: string): Promise<void> {
    if (!URL.canParse(url)) return Promise.resolve();
    const { origin, protocol } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return Promise.resolve();
    this.visited.add(origin);
    const { connection, settings } = this.host;
    if (settings.permissions.length === 0) return Promise.resolve();
    let grant = this.granted.get(origin);
    if (grant === undefined) {
      const userContext = this.current;
      grant = this.set(
        'permissions',
        () => Promise.all(settings.permissions.map((name) => connection.send('permissions.setPermission', { descriptor: { name }, state: 'granted', origin, userContext }))),
        () => ChromiumCdp.browser(connection).send('Browser.resetPermissions', {}),
      );
      this.granted.set(origin, grant);
    }
    return grant;
  }

  /**
   * A new user context of the browser's. A browser that refuses to create
   * one (an Electron app has only its own) fails as `UNSUPPORTED_CAPABILITY`
   * when the settings know what to do instead, with the browser's words.
   */
  private async create(): Promise<string> {
    const { connection, settings } = this.host;
    try {
      return (await connection.send('browser.createUserContext', {})).userContext;
    } catch (cause) {
      if (settings.withoutUserContexts === undefined || !(cause instanceof BidiError)) throw cause;
      throw new EngineError('UNSUPPORTED_CAPABILITY', `the browser cannot create a browser context (${cause.detail}). ${settings.withoutUserContexts}`, { retryable: false, cause });
    }
  }

  /**
   * Creates a user context (the browser's own one when the settings ask for
   * it) and applies everything scoped to it: the preloaded scripts,
   * downloads, the emulated user agent, locale (and the `accept-language`
   * Playwright's locale sends), time zone, and media, each through `set`,
   * so the browser's own user context gets it back. Every step settles
   * before a failure is thrown, and a failed or overtaken setup removes what
   * it made. None is created once the attempt closed. Once set up, it is
   * published in place of the attempt's user context, whose scope is
   * returned.
   */
  private async install(signal: AbortSignal): Promise<ScopedUserContext> {
    const generation = ++this.generation;
    const { connection, settings, lifetime } = this.host;
    signal.throwIfAborted();
    if (lifetime.aborted) throw abortError(lifetime, 'user context setup');
    const userContext = settings.userContext === 'fresh' ? await this.create() : DEFAULT_USER_CONTEXT;
    const preloads: string[] = [];
    const overtaken = (): boolean => signal.aborted || lifetime.aborted || generation !== this.generation;
    try {
      if (overtaken()) throw abortError(signal, 'user context setup');
      const scoped = { userContexts: [userContext] as [string] };
      const sources = [
        ...this.driverScripts().map(wrapScript),
        ...[...settings.initScripts.forAttempt(), ...this.addedScripts].map(wrapAppScript),
      ];
      const { userAgent, locale, timezoneId } = settings;
      const steps = await Promise.allSettled([
        ...sources.map(async (source) => {
          preloads.push((await connection.send('script.addPreloadScript', { functionDeclaration: source, ...scoped })).script);
        }),
        this.set('downloads', () => this.host.downloads.allow(userContext), () => connection.send('browser.setDownloadBehavior', { downloadBehavior: null, ...scoped })),
        userAgent === undefined ? undefined : this.set(
          'user agent',
          () => connection.send('emulation.setUserAgentOverride', { userAgent, ...scoped }),
          () => connection.send('emulation.setUserAgentOverride', { userAgent: null, ...scoped }),
        ),
        locale === undefined ? undefined : this.set(
          'locale',
          () => connection.send('emulation.setLocaleOverride', { locale, ...scoped }),
          () => connection.send('emulation.setLocaleOverride', { locale: null, ...scoped }),
        ),
        locale === undefined ? undefined : this.set(
          'accept-language',
          () => connection.send('network.setExtraHeaders', { headers: [{ name: 'accept-language', value: { type: 'string', value: locale } }], ...scoped }),
          () => connection.send('network.setExtraHeaders', { headers: [], ...scoped }),
        ),
        timezoneId === undefined ? undefined : this.set(
          'time zone',
          () => connection.send('emulation.setTimezoneOverride', { timezone: timezoneId, ...scoped }),
          () => connection.send('emulation.setTimezoneOverride', { timezone: null, ...scoped }),
        ),
        this.applyMedia(userContext),
      ]);
      const failed = steps.find((step) => step.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
      if (overtaken()) throw abortError(signal, 'user context setup');
    } catch (cause) {
      await releaseQuietly(this.drop({ userContext, preloads }));
      throw cause;
    }
    const previous = { userContext: this.current, preloads: this.preloads };
    this.current = userContext;
    this.preloads = preloads;
    this.granted.clear();
    this.visited.clear();
    return previous;
  }

  /**
   * Removes a user context the attempt no longer uses, which closes its
   * tabs, then its preload scripts: removing a script from a live tab races
   * the tab's close inside the Chromium mapper. The browser's own user
   * context stays, with its tabs: the session closes the ones the attempt
   * opened there before it drops the scripts, and what the attempt set in
   * it is taken back (`takeBack`), unless the attempt still runs in it.
   */
  private async drop(dropped: ScopedUserContext): Promise<void> {
    const { connection } = this.host;
    if (dropped.userContext !== DEFAULT_USER_CONTEXT && dropped.userContext !== '') this.unremoved.add(dropped.userContext);
    try {
      await this.removeOwed();
      if (dropped.userContext === DEFAULT_USER_CONTEXT && this.current !== DEFAULT_USER_CONTEXT) await this.takeBack();
    } finally {
      await Promise.all(dropped.preloads.map((script) => releaseQuietly(connection.send('script.removePreloadScript', { script }))));
    }
  }

  /**
   * Takes back everything the attempt set in the user context it does not
   * remove, and in the tab it adopted there (`kept`): the one place an
   * attempt gives the browser's own user context back as it found it. Every
   * call is made whatever the others did, and the first failure is thrown:
   * what stays set is what the next attempt, and the browser's own user,
   * would run with. A document the attempt left open keeps what scripts did
   * in it (the driver's own, the app's init scripts) until it navigates.
   */
  private async takeBack(): Promise<void> {
    const calls = [...this.kept.values()];
    this.kept.clear();
    const results = await Promise.allSettled(calls.map((call) => call()));
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }

  /**
   * Applies the media features to `userContext`
   * (`emulation.setMediaFeaturesOverride`); a browser that does not emulate
   * reduced motion takes it as a launch preference.
   */
  private async applyMedia(userContext: string): Promise<void> {
    if (this.media.colorScheme === undefined && this.media.reducedMotion === undefined) return;
    const { connection } = this.host;
    const features: Emulation.MediaFeatures = obj({
      'prefers-color-scheme': this.media.colorScheme === 'no-preference' ? null : this.media.colorScheme,
      'prefers-reduced-motion': this.host.traits.emulatesReducedMotion ? this.media.reducedMotion : undefined,
    });
    await this.set(
      'media',
      () => connection.send('emulation.setMediaFeaturesOverride', { features, userContexts: [userContext] }),
      () => connection.send('emulation.setMediaFeaturesOverride', { features: null, userContexts: [userContext] }),
    );
  }
}

/** The query parameter that marks a scratch document a saved-state read or write opens, which the app's init scripts skip. */
export const SCRATCH_PARAM = '__e2e_state_scratch';

/** A driver script's source as a preload script's function declaration. */
function wrapScript(source: string): string {
  return `() => {\n${source}\n}`;
}

/** An app init script's source as a preload script's function declaration: it runs in every document but a saved-state scratch one, which it must not change. */
function wrapAppScript(source: string): string {
  return `() => {\nif (new URLSearchParams(location.search).has(${JSON.stringify(SCRATCH_PARAM)})) return;\n${source}\n}`;
}
