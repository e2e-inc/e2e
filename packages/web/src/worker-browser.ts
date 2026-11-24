/**
 * The worker's browser: what every attempt a worker runs shares, and what
 * lives as long as the worker does. The browser connection, a provider's
 * leases, the configured init scripts, what `init` learned, and the attempts
 * that are open are here, beside the run and worker lifecycle and how a
 * browser is acquired. What one attempt owns (its context, pages, routes,
 * dialogs, video) is a `PlaywrightSurface` on this.
 */

import type { Browser } from 'playwright-core';
import {
  ConfigurationError,
  EngineError,
  raceAbort,
  withinCleanupBudget,
  type EngineAppInfo,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineDoctorCheck,
  type EngineDoctorInfo,
  type EngineFinishInfo,
  type EngineInitInfo,
  type EnginePrepareInfo,
  type EnginePrepareResult,
} from '@e2e-dev/core/engine';
import { BrowserConnection, connectCdp, defaultChromiumSandbox, type BrowserLaunchOptions, type BrowserName } from './browser-connection.ts';
import type { CdpEndpointResolver } from './cdp-recovery.ts';
import { missingLibrariesMessage } from './host-libraries.ts';
import { ConfiguredInitScripts } from './init-scripts.ts';
import { browserCheck, ensureBrowsersInstalled, missingBrowserLibraries } from './install.ts';
import { credentialOrigins, lowercaseNames } from './protected-app.ts';
import { LeasedBrowsers } from './provider.ts';
import { cancelled, invalidState, message, translatePwError } from './support.ts';
import { PlaywrightSurface, type WebConnectOptions, type WebOptions } from './surface.ts';
import { webmcpLaunch } from './webmcp.ts';

/** Browser launch budget when the harness init budget is not otherwise expressed. */
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;

/** What names an attempt on a call: the id its `startAttempt` got, absent from a harness that predates actors. */
export interface AttemptName {
  readonly attemptId?: string | undefined;
}

/** The test-id attribute when the options name none. */
const DEFAULT_TEST_ID_ATTRIBUTE = 'data-testid';

export class WorkerBrowser {
  readonly browserName: BrowserName;
  /** The worker's browser, which the surface of each attempt shares. */
  private readonly connection = new BrowserConnection();
  private readonly chromiumSandbox: boolean;
  /** What the options add to the launch of the browser the engine launches. */
  private readonly launch: BrowserLaunchOptions;
  private readonly connect: WebConnectOptions | undefined;
  /** The provider's browsers, when `browser` names one; the runner and worker halves of the lease bookkeeping. */
  readonly leases: LeasedBrowsers | undefined;
  /** The default contexts earlier attempts rode on a `connect` resolver's browsers, kept for the worker's life so a later attempt is refused one of them. */
  private readonly usedContexts = new Set<string>();
  readonly configuredInitScripts: ConfiguredInitScripts;
  readonly testIdAttribute: string;
  /** Injected request headers, names lowercased so they replace the browser's own of the same name. */
  readonly headers: Readonly<Record<string, string>> | undefined;
  /** Where `headers` and `basicAuth` go: the app's origin and each of `credentialOrigins`, set at `init`. */
  credentialScope: ReadonlySet<string> = new Set();
  app: EngineAppInfo = {};
  projectRoot = '';
  private headed = false;
  /** The surface of each open attempt: a context of its own on the worker's browser. Set before its `start` awaits anything. */
  private readonly attempts = new Map<string, PlaywrightSurface>();

  constructor(readonly options: WebOptions) {
    this.browserName = typeof options.browser === 'string' ? options.browser : 'chromium';
    this.chromiumSandbox = options.chromiumSandbox ?? defaultChromiumSandbox();
    this.leases = typeof options.browser === 'object' && options.browser !== null ? new LeasedBrowsers(options.browser) : undefined;
    this.connect = options.connect;
    this.launch = options.webmcp === true ? webmcpLaunch(this.browserName) : {};
    this.configuredInitScripts = new ConfiguredInitScripts(options.initScripts ?? []);
    this.testIdAttribute = options.testIdAttribute ?? DEFAULT_TEST_ID_ATTRIBUTE;
    this.headers = options.headers === undefined ? undefined : lowercaseNames(options.headers);
  }

  // --- lifecycle ---

  /**
   * Installs the browser on first run, once per run before any worker, or
   * leases the run's browsers from a provider. A CDP attach uses the
   * remote's browser, so only a local launch needs the browser here. The
   * download narrates through `info.log` and is bounded by the run's
   * interrupt alone, never by a launch budget. Init scripts are read first
   * so a missing file fails the run before any worker starts.
   */
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult | void> {
    await this.configuredInitScripts.load(info.projectRoot);
    if (this.leases !== undefined) return this.leases.prepare(info);
    if (this.connect !== undefined) return;
    await ensureBrowsersInstalled([this.browserName], { env: info.env, signal: info.signal, log: info.log, headed: info.headed });
  }

  /**
   * The checks of `e2e doctor`: the init scripts `prepare` reads, and the
   * browser, which only a local launch needs on this machine.
   */
  async doctor(info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]> {
    const scripts = await this.configuredInitScripts.doctor(info.projectRoot);
    if (this.leases !== undefined) return [...scripts, { id: 'browser', status: 'skip', message: `browsers come from the "${this.leases.name}" provider` }];
    if (this.connect !== undefined) return [...scripts, { id: 'browser', status: 'skip', message: 'the browser is attached over CDP' }];
    return [...scripts, ...(await browserCheck(this.browserName, info.env, info.headed))];
  }

  /** Releases the browsers `prepare` leased; a local launch or a `connect` has nothing to release. */
  async finish(info: EngineFinishInfo): Promise<void> {
    await this.leases?.finish(info);
  }

  /** Provisions the shared browser once per worker: a local launch, or a CDP attach. */
  async init(info: EngineInitInfo): Promise<void> {
    // A runner older than the peer floor passes no origin; fail rather than send the credentials nowhere.
    if (info.app.origin === undefined && (this.options.headers !== undefined || this.options.basicAuth !== undefined)) {
      throw new ConfigurationError('INVALID_CONFIG', 'web({ headers, basicAuth }) needs an e2e runner that tells the engine the app\'s origin; update e2e to the release beside this @e2e-dev/web');
    }
    this.app = info.app;
    this.credentialScope = credentialOrigins(info.app.origin, this.options.credentialOrigins);
    this.projectRoot = info.projectRoot;
    this.headed = info.headed;
    this.leases?.init(info);
    // The browser was installed in `prepare`; a launch or attach is the one
    // boot step left that can outlive a launch budget, and it honours the
    // init signal. A failed init-script read throws only after the launch
    // settles, so `dispose` owns the browser.
    const settled = await Promise.allSettled([
      this.configuredInitScripts.load(info.projectRoot),
      this.persistent ? undefined : this.acquireBrowser(info.signal),
    ]);
    for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason;
  }

  /**
   * Whether attempts ride a persistent remote context, provisioned per
   * attempt, instead of contexts on one shared browser: `reconnectEndpoint`,
   * or a per-attempt lease, which has the same limits.
   */
  get persistent(): boolean {
    return this.connect?.reconnectEndpoint !== undefined || this.leases?.scope === 'attempt';
  }

  /**
   * Provisions the shared browser through the shared connection (a launch, or a CDP attach
   * via the connector), bounded by `signal`. Checked before the endpoint is
   * resolved: a cancelled caller must never provision a remote session it will
   * not use.
   */
  async acquireBrowser(signal: AbortSignal): Promise<Browser> {
    const verb = this.connect === undefined && this.leases === undefined ? 'launch' : 'connect';
    if (signal.aborted) throw cancelled(`browser ${verb} cancelled`);
    try {
      return await raceAbort(
        this.connection.acquire({
          name: this.browserName,
          headed: this.headed,
          timeoutMs: BROWSER_LAUNCH_TIMEOUT_MS,
          chromiumSandbox: this.chromiumSandbox,
          launch: this.launch,
          connect: this.connector(signal),
        }),
        signal,
        `browser ${verb}`,
      );
    } catch (cause) {
      if (cause instanceof EngineError) throw cause;
      // The probe is the one await after the launch settled, so it stops with the init signal too.
      const missing = verb === 'launch' ? await missingBrowserLibraries(this.browserName, process.env, this.headed, { signal }) : [];
      // The launch's own reason follows the advice: it can name a second fault the libraries do not explain.
      const reason = missing.length > 0 ? `${missingLibrariesMessage(this.browserName, missing)}\nlaunch error: ${message(cause)}` : message(cause);
      throw new EngineError('ENGINE_FAILURE', `browser ${verb} failed: ${reason}`, {
        retryable: false,
        cause,
      });
    }
  }

  /**
   * Builds the connection's connector when attaching over CDP; undefined for a local
   * launch. The connector honours `signal` at every await: the resolver
   * receives it, the endpoint is not used once aborted, and a browser that
   * connects after cancellation is detached at once rather than cached: the
   * host's session is never held by an init or attempt that already gave up.
   */
  private connector(signal: AbortSignal): (() => Promise<Browser>) | undefined {
    const source = this.endpointSource();
    if (source === undefined) return undefined;
    return async () => {
      const resolved = await source.resolve(signal);
      const target = typeof resolved === 'string' ? { endpoint: resolved } : resolved;
      if (signal.aborted) throw cancelled('browser connect cancelled');
      if (typeof target?.endpoint !== 'string' || target.endpoint.trim() === '') {
        throw new EngineError('ENGINE_FAILURE', `${source.name} resolved to an empty CDP endpoint`, {
          retryable: false,
        });
      }
      const browser = await connectCdp(target, BROWSER_LAUNCH_TIMEOUT_MS);
      if (signal.aborted) {
        await browser.close().catch(() => undefined);
        throw cancelled('browser connect cancelled');
      }
      return browser;
    };
  }

  /**
   * Where the shared browser's CDP endpoint comes from: the `connect`
   * resolver, or the lease the worker holds from a provider; undefined for a
   * local launch.
   */
  private endpointSource(): { readonly name: string; readonly resolve: CdpEndpointResolver } | undefined {
    if (this.connect !== undefined) return { name: 'connect.cdpEndpoint', resolve: this.connect.cdpEndpoint };
    if (this.leases === undefined) return undefined;
    return { name: 'the browser provider', resolve: (signal) => this.leaseEndpoint(signal) };
  }

  /** The endpoint of the lease the worker holds; only reached with a provider. */
  private leaseEndpoint(signal: AbortSignal): ReturnType<LeasedBrowsers['endpoint']> {
    if (this.leases === undefined) throw invalidState('no browser provider is configured');
    return this.leases.endpoint(signal);
  }

  /**
   * The persistent remote context this attempt rides, when it does: the
   * `connect` resolvers, or a browser leased for this attempt alone, which
   * reconnects through the lease's own endpoint and is fresh by the
   * provider's contract, so no earlier attempt's context is checked against
   * it. Undefined for isolated contexts on the shared browser.
   */
  async persistentBinding(
    context: EngineAttemptContext,
  ): Promise<{ provision: CdpEndpointResolver; reconnect: CdpEndpointResolver; usedContexts?: Set<string> } | undefined> {
    const { connect, usedContexts } = this;
    if (connect?.reconnectEndpoint !== undefined) {
      return { provision: connect.cdpEndpoint, reconnect: connect.reconnectEndpoint, usedContexts };
    }
    if (this.leases?.scope !== 'attempt') return undefined;
    const leases = this.leases;
    const lease = await leases.startAttempt(context);
    return {
      provision: (signal) => leases.cdpTarget(lease, signal),
      reconnect: (signal) => leases.cdpTarget(lease, signal, lease.reconnectEndpoint ?? lease.cdpEndpoint),
    };
  }

  /** Builds the surface of one attempt and opens its session. The attempt is open from here until `endAttempt`, whether or not the session opens. */
  async startAttempt(context: EngineAttemptContext): Promise<void> {
    // A persistent context is the one a remote browser has: a second attempt has none to run in, and is refused there.
    // So is a second start under an id that is open, anywhere: its calls would have two attempts to reach.
    if (this.attempts.has(context.attemptId) || (this.persistent && this.attempts.size > 0)) throw invalidState('an attempt is already running');
    const surface = new PlaywrightSurface(this, context);
    this.attempts.set(context.attemptId, surface);
    await surface.start();
  }

  /**
   * The surface of the open attempt a call is for, or undefined when that
   * attempt is not open: the one the call names, or the one open attempt
   * for a harness that names none, which runs one at a time. With several
   * open, a call that names none could reach the wrong one's page, and is
   * refused.
   */
  private find({ attemptId }: AttemptName): PlaywrightSurface | undefined {
    if (attemptId !== undefined) return this.attempts.get(attemptId);
    const [only, ...rest] = this.attempts.values();
    if (rest.length === 0) return only;
    throw invalidState(`${this.attempts.size} attempts are running and this call names none: pass the attempt id, as in surfaceOf(engine, attemptId)`);
  }

  /**
   * The surface of the attempt a call names. A call for an attempt that is
   * not open is refused, while another is open too: it must never reach
   * that one's page.
   */
  attempt(name: AttemptName): PlaywrightSurface {
    const surface = this.find(name);
    if (surface !== undefined) return surface;
    throw invalidState(this.attempts.size === 0 ? 'no attempt is running' : 'the attempt this call belongs to is not running: it ended, or never started here');
  }

  /** Settles the attempt a cleanup is for; one that is not open has no handler left to wait for. */
  async settleAttempt(context: EngineCleanupContext): Promise<void> {
    await this.find(context)?.settle(context);
  }

  /** Ends the attempt a cleanup is for. One that is not open already ended: nothing of it is left to end. */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    const surface = this.find(context);
    if (surface === undefined) return;
    this.attempts.delete(surface.attemptId);
    await surface.end(context);
  }

  /**
   * Ends the attempts still open, together, then releases the worker's
   * shared browser process, then a lease the worker acquired for itself:
   * every one attempted whatever the earlier ones did, and the first failure
   * reported once all ran. Each open context closes before the browser goes
   * down, so its video is finalized, and a billed browser outlives a failed
   * recording flush otherwise.
   */
  async dispose(context: EngineCleanupContext): Promise<void> {
    const open = [...this.attempts.values()];
    this.attempts.clear();
    // Each has the cleanup budget from its own start: one context that hangs on close must not spend another's.
    const ended = await Promise.allSettled(open.map((surface) => surface.end(context)));
    const failures: unknown[] = ended.flatMap((outcome) => (outcome.status === 'rejected' ? [outcome.reason] : []));
    for (const release of [() => withinCleanupBudget(this.connection.dispose(), context), async () => this.leases?.dispose(context)]) {
      try {
        await release();
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0) throw translatePwError(failures[0], 'dispose');
  }
}
