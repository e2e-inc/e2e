/**
 * The worker's browser: what every attempt a worker runs shares, and what
 * lives as long as the worker does. The browser connection, a provider's
 * leases, the configured init scripts, and what `init` learned are here,
 * beside the run and worker lifecycle and how a browser is acquired. What one
 * attempt owns (its context, pages, routes, dialogs, video) is a
 * `PlaywrightSurface` on this.
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
import { credentialOrigins } from './protected-app.ts';
import { LeasedBrowsers } from './provider.ts';
import { cancelled, invalidState, message, translatePwError } from './support.ts';
import type { WebConnectOptions, WebOptions } from './surface.ts';
import { webmcpLaunch } from './webmcp.ts';

/** Browser launch budget when the harness init budget is not otherwise expressed. */
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;

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
  /** Where `headers` and `basicAuth` go: the app's origin and each of `credentialOrigins`, set at `init`. */
  credentialScope: ReadonlySet<string> = new Set();
  app: EngineAppInfo = {};
  projectRoot = '';
  private headed = false;

  constructor(private readonly options: WebOptions) {
    this.browserName = typeof options.browser === 'string' ? options.browser : 'chromium';
    this.chromiumSandbox = options.chromiumSandbox ?? defaultChromiumSandbox();
    this.leases = typeof options.browser === 'object' && options.browser !== null ? new LeasedBrowsers(options.browser) : undefined;
    this.connect = options.connect;
    this.launch = options.webmcp === true ? webmcpLaunch(this.browserName) : {};
    this.configuredInitScripts = new ConfiguredInitScripts(options.initScripts ?? []);
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

  /** Whether attempts ride a persistent remote context, provisioned per attempt, instead of contexts on one shared browser. */
  private get persistent(): boolean {
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

  /**
   * Releases the worker's shared browser process and a lease the worker
   * acquired for itself: two independent tasks, in that order, the second
   * attempted whatever the first did, and the first failure reported once
   * both ran. The attempts still open are ended before it, by `web()`.
   */
  async dispose(context: EngineCleanupContext): Promise<void> {
    const tasks = [
      () => withinCleanupBudget(this.connection.dispose(), context),
      async () => this.leases?.dispose(context),
    ];
    let failure: { cause: unknown } | undefined;
    for (const task of tasks) {
      try {
        await task();
      } catch (cause) {
        failure ??= { cause };
      }
    }
    if (failure !== undefined) throw translatePwError(failure.cause, 'dispose');
  }
}
