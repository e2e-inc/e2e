/**
 * One attempt's network: the test's routes, the in-flight request count a
 * `networkidle` wait reads, and the binding to the attempt's current user
 * context, which installs what they need (`network-binding.ts`) and has each
 * request it holds decided (`network-decisions.ts`). Interception and the
 * extra subscriptions start only when something needs them, since each
 * blocked request costs a protocol round trip.
 */

import { releaseQuietly } from '../errors.ts';
import type { BidiConnection } from './connection.ts';
import { NetworkBinding, alreadyGone, type NetworkOptions, type ObservedResponse } from './network-binding.ts';
import type { NetworkRoute } from './network-decisions.ts';

/** One attempt's network: its routes and policy, and the binding to the current user context that carries out both. */
export class AttemptNetwork {
  /** Oldest first; every binding reads them as they are when a request is held. */
  private readonly routes: NetworkRoute[] = [];
  /** Whether requests in flight are counted, once a `networkidle` wait asked for it. */
  private tracking = false;
  /** The current user context's state and resources; replaced whole by `bind`. */
  private binding: NetworkBinding | undefined;
  /** Removals that failed, tried again by the next release so nothing is forgotten while the browser still holds it. */
  private unreleased: (() => Promise<unknown>)[] = [];
  /** Serializes changes to the intercepts and subscriptions, which each take round trips. */
  private changes: Promise<void> = Promise.resolve();
  /** Whether the attempt's network ended (`dispose`). */
  private disposed = false;

  constructor(
    private readonly connection: BidiConnection,
    private readonly options: NetworkOptions,
  ) {}

  /** Runs `work` after every earlier change; a failed change rejects its caller and lets the next run. */
  private change(work: () => Promise<void>): Promise<void> {
    const next = this.changes.then(work);
    this.changes = releaseQuietly(next);
    return next;
  }

  /** Installs what the attempt's routes, headers, credentials, and waits need on the bound user context, whatever an earlier try left out, and removes what nothing needs any more. */
  private async reconcile(): Promise<void> {
    await this.binding?.reconcile(this.tracking);
  }

  /**
   * Binds the network to a fresh user context (the attempt's first, or the
   * one a reset or restore replaced it with). The old binding ends first,
   * with every request it tracked, and its resources are removed; the new
   * one starts with no tabs and no requests. It is in place with what the
   * attempt needs whatever became of the removals: one that failed stays
   * for the next release (`unreleased`) and rejects the bind once the new
   * binding stands, so the attempt never runs a user context unbound. The
   * response collector starts here, so a response wait has nothing to set
   * up before the action it waits on can fire the response.
   */
  bind(userContext: string): Promise<void> {
    return this.change(async () => {
      const old = this.binding;
      this.binding = undefined;
      old?.close();
      try {
        await this.release(old);
      } finally {
        // An attempt that ended while the old binding was released binds no new one, which nothing would ever release.
        if (!this.disposed) {
          this.binding = new NetworkBinding(this.connection, userContext, this.options, this.routes);
          await this.reconcile();
        }
      }
    });
  }

  /**
   * A top-level tab of the attempt opened: the intercepts cover it from now
   * on. A tab the context tree no longer knows closed before the queue
   * caught up, and is left out instead of covering a tab that no longer exists.
   */
  addContext(context: string): Promise<void> {
    const binding = this.binding;
    return this.change(async () => {
      if (binding !== undefined && binding === this.binding && binding.cover(context)) await this.reconcile();
    });
  }

  /** A top-level tab of the attempt closed: its requests in flight stop counting, and the intercepts stop covering it. */
  removeContext(context: string): Promise<void> {
    const binding = this.binding;
    this.retire(context);
    return this.change(async () => {
      if (binding !== undefined && binding === this.binding && binding.uncover(context)) await this.reconcile();
    });
  }

  /**
   * A browsing context of the attempt (a tab or a frame) closed: the
   * requests in flight from it and every frame in it stop counting, whatever
   * events their teardown still sends. Call it before the tree forgets them.
   */
  retire(context: string): void {
    this.binding?.retire(this.options.contexts.subtree(context));
  }

  /**
   * Answers every document request of `context`, a tab of the attempt, with
   * a blank page before any route sees it, so a page at an origin can run
   * script without the app's server seeing a request. Returns the undo; a
   * failed install takes the tab back out, since no undo is returned for it.
   */
  async serveBlank(context: string): Promise<() => Promise<void>> {
    let binding: NetworkBinding | undefined;
    await this.change(async () => {
      binding = this.binding;
      binding?.serveBlank(context);
      try {
        await this.reconcile();
      } catch (cause) {
        binding?.unserveBlank(context);
        throw cause;
      }
    });
    return () => this.change(async () => {
      binding?.unserveBlank(context);
      if (binding !== undefined && binding === this.binding) await this.reconcile();
    });
  }

  /**
   * Starts counting the attempt's requests in flight, for a `networkidle`
   * wait. Call it before the navigation the wait follows.
   */
  track(): Promise<void> {
    return this.change(async () => {
      this.tracking = true;
      await this.reconcile();
    });
  }

  /**
   * Registers a route for every request from now on; the newest route sees a
   * request first. The route counts only once what holds requests for it is
   * installed; a failed install takes it back out.
   */
  addRoute(route: NetworkRoute): Promise<void> {
    return this.change(async () => {
      this.routes.push(route);
      try {
        await this.reconcile();
      } catch (cause) {
        this.dropRoutes((one) => one === route);
        throw cause;
      }
    });
  }

  /**
   * Removes the routes `match` selects, in order with the additions before
   * it, and lets interception go once nothing needs requests held.
   */
  removeRoutes(match: (route: NetworkRoute) => boolean): Promise<void> {
    return this.change(async () => {
      this.dropRoutes(match);
      await this.reconcile();
    });
  }

  /** Takes the routes `match` selects out of the attempt's routes, in place. */
  private dropRoutes(match: (route: NetworkRoute) => boolean): void {
    this.routes.splice(0, this.routes.length, ...this.routes.filter((route) => !match(route)));
  }

  /**
   * Resolves once no request of the attempt's tab has been in flight for
   * 500 ms, Playwright's `networkidle`; a tab the app opened does not count,
   * nor does a request of a user context the attempt has since replaced.
   * `track` must have run before the navigation it follows, so the requests
   * it started were counted.
   */
  async waitForIdle(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const remaining = this.binding === undefined ? 0 : this.binding.untilIdle();
      if (remaining !== undefined && remaining <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, remaining ?? 50)));
    }
  }

  /**
   * Resolves with the first response of the attempt's tab whose URL
   * `matches`, once its headers arrive; reading its body waits for the load
   * to finish, and fails if the network ends first (`NetworkBinding.waitForResponse`).
   */
  waitForResponse(matches: (url: string) => boolean, signal: AbortSignal): Promise<ObservedResponse> {
    const binding = this.binding;
    if (binding === undefined) return Promise.reject(new Error('waitForResponse: the network is not bound to a user context'));
    return binding.waitForResponse(matches, signal);
  }

  /**
   * Removes the resources of `binding` (every intercept it added, so one a
   * failed replacement left behind goes too, its collectors, and its
   * subscription) and any earlier removal that failed, every one attempted;
   * one the browser no longer has is done, any other failure is thrown so
   * the attempt's close reports it and the browser is retired rather than
   * reused with it in place.
   */
  private async release(binding: NetworkBinding | undefined): Promise<void> {
    const connection = this.connection;
    const removals = [...this.unreleased, ...(binding?.removals() ?? [])];
    const results = await Promise.allSettled(removals.map((removal) => alreadyGone(removal(), connection)));
    this.unreleased = removals.filter((_removal, index) => results[index]!.status === 'rejected');
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined) throw failed.reason;
  }

  /** Ends the attempt's network: listeners, pending response waits, routes, intercepts, collectors, and subscription. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const binding = this.binding;
    this.binding = undefined;
    binding?.close();
    this.routes.length = 0;
    await this.change(() => this.release(binding));
  }
}
