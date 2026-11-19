/**
 * The navigations the driver itself has in flight in the attempt's tab: the
 * trace leaves them to the step that started them, and one whose document
 * request a test route aborted fails as the test's doing.
 */

import { TestError } from '@e2e-dev/core/engine';
import { isClassified, message } from '../errors.ts';

/** The driver's own navigations in flight, each told the URL of the document request a test route aborted under it. */
export class OwnNavigations {
  private readonly watches = new Set<{ url?: string }>();

  /** Whether the driver has a navigation in flight. */
  get inFlight(): boolean {
    return this.watches.size > 0;
  }

  /** A test route aborted the tab's document request for `url`: every navigation in flight learns of the first one. */
  aborted(url: string): void {
    for (const watch of this.watches) watch.url ??= url;
  }

  /**
   * Runs a navigation the driver makes itself, which the trace leaves to the
   * step that asked for it. A navigation that fails after a test route aborted
   * the tab's document request failed because the test aborted it: an action
   * failure, not an engine fault.
   */
  async own<T>(work: () => Promise<T>): Promise<T> {
    const watch: { url?: string } = {};
    this.watches.add(watch);
    try {
      return await work();
    } catch (cause) {
      if (watch.url === undefined || isClassified(cause)) throw cause;
      throw new TestError('ACTION_FAILED', `navigation failed: a route aborted the request for ${watch.url}: ${message(cause)}`, { cause });
    } finally {
      this.watches.delete(watch);
    }
  }
}
