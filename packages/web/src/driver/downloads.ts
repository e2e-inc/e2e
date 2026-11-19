/**
 * Downloads: the attempt's user context saves every
 * download into a directory of its own (`browser.setDownloadBehavior`), on
 * this machine or, for a provider that serves downloads, on the browser's,
 * and a wait pairs `browsingContext.downloadWillBegin` with `downloadEnd` by
 * the download's id.
 */

import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EngineError, TestError } from '@e2e-dev/core/engine';
import type { LeaseDownloads } from '../provider.ts';
import type { ArtifactPaths } from './artifact-paths.ts';
import { afterTrigger, type OperationBudget } from './budget.ts';
import type { BidiConnection } from './connection.ts';

/**
 * How the downloads of a provider's browser reach this machine: read back
 * through the provider, or, for a provider that serves none, found where the
 * browser saved them, which is here when the browser runs on this machine.
 * `unserved` is why a download saved on another machine cannot be read.
 */
export type RemoteDownloads = LeaseDownloads | { readonly unserved: string };

/** A download saved into the attempt's `downloads` folder: its path under the attempt's artifacts, and on disk. */
export interface SavedDownload {
  readonly path: string;
  readonly absolutePath: string;
  readonly suggestedFilename: string;
}

/** One attempt's downloads: their directory, and waits for the downloads a trigger starts. */
export class AttemptDownloads {
  readonly dir: string;

  /**
   * `remote` is how the downloads of a provider's browser reach this
   * machine; undefined for a browser that saves them here. `artifacts` gives each
   * saved download its path in the attempt's `downloads` folder, and `onPage`
   * says whether a context is the attempt's tab or a frame in it.
   */
  constructor(
    private readonly connection: BidiConnection,
    private readonly remote: RemoteDownloads | undefined,
    private readonly artifacts: ArtifactPaths,
    private readonly onPage: (context: string) => boolean,
  ) {
    this.dir = this.served?.dir ?? mkdtempSync(path.join(os.tmpdir(), 'e2e-bidi-downloads-'));
  }

  /** The provider that reads a download back off the browser's disk, when the browser saves them on another machine and its provider serves them. */
  private get served(): LeaseDownloads | undefined {
    return this.remote !== undefined && 'read' in this.remote ? this.remote : undefined;
  }

  /** Points the user context's downloads at this attempt's directory. */
  async allow(userContext: string): Promise<void> {
    await this.connection.send('browser.setDownloadBehavior', {
      downloadBehavior: { type: 'allowed', destinationFolder: this.dir },
      userContexts: [userContext],
    });
  }

  /**
   * Runs `trigger` and saves the first `count` downloads it starts in the
   * attempt's tab into the attempt's `downloads` folder, in start order
   * (`browser.waitForDownload`), once each has finished and the trigger
   * returned (`afterTrigger`): copied from this machine, or read off the
   * remote browser's disk through its provider. One budget bounds the
   * trigger, the downloads, and reading each back; past it the wait stops
   * listening and fails, whatever the trigger is still doing, naming what it
   * still waited for. A canceled download fails the wait. Every download is
   * read back before the first is written, and a write that fails takes the
   * ones before it along, so a wait that fails saves none: a file no step
   * attached is never redacted. A download a provider's browser saved on
   * another machine, and the provider does not serve, is refused by the
   * provider's name.
   */
  async save(count: number, trigger: () => Promise<void>, budget: OperationBudget): Promise<SavedDownload[]> {
    const { served } = this;
    const unserved = this.remote !== undefined && 'unserved' in this.remote ? this.remote.unserved : undefined;
    const { timeoutMs } = budget;
    const started: { readonly id: string; readonly suggestedFilename: string }[] = [];
    const ended = new Map<string, string | null>();
    /** What a wait that runs out while the provider reads a download back says. */
    let slowRead: string | undefined;
    let settled: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (settled = resolve));
    const check = (): void => {
      if (started.length === count && started.every((download) => ended.has(download.id))) settled();
    };
    const offBegin = this.connection.on('browsingContext.downloadWillBegin', (event) => {
      if (!this.onPage(event.context) || started.length === count) return;
      started.push({ id: event.download, suggestedFilename: event.suggestedFilename });
      check();
    });
    const offEnd = this.connection.on('browsingContext.downloadEnd', (event) => {
      ended.set(event.download, event.status === 'complete' ? event.filepath : null);
      check();
    });
    try {
      return await afterTrigger(trigger, async (signal) => {
        await done;
        const finished = started.map(({ id, suggestedFilename }) => {
          const filepath = ended.get(id);
          // A browser on another machine may fail to save into a folder named by this machine's path.
          if (filepath == null) throw new TestError('ACTION_FAILED', `download ${suggestedFilename} was canceled${unserved === undefined ? '' : `; if the browser runs on another machine: ${unserved}`}`);
          return { suggestedFilename, filepath };
        });
        const writes: { readonly suggestedFilename: string; readonly write: (absolute: string) => void }[] = [];
        for (const { suggestedFilename, filepath } of finished) {
          if (served === undefined) {
            if (unserved !== undefined && !existsSync(filepath)) throw new EngineError('UNSUPPORTED_CAPABILITY', `download ${suggestedFilename} is not on this machine: ${unserved}`, { retryable: false });
            writes.push({ suggestedFilename, write: (absolute) => copyFileSync(filepath, absolute) });
            continue;
          }
          slowRead = `download ${suggestedFilename} did not finish: ${served.provider} read it back too slowly`;
          const bytes = await served.read(filepath, signal, suggestedFilename);
          writes.push({ suggestedFilename, write: (absolute) => writeFileSync(absolute, bytes) });
        }
        signal.throwIfAborted();
        const saved: SavedDownload[] = [];
        try {
          for (const { suggestedFilename, write } of writes) {
            const { relative, absolute } = this.artifacts.reserve('downloads', suggestedFilename, '');
            saved.push({ path: relative, absolutePath: absolute, suggestedFilename });
            write(absolute);
          }
        } catch (cause) {
          for (const { absolutePath } of saved) rmSync(absolutePath, { force: true });
          throw cause;
        }
        return saved;
      }, budget, (triggerMs) => {
        if (triggerMs === undefined) return new TestError('ACTION_FAILED', `the download trigger did not resolve within ${timeoutMs}ms`);
        if (slowRead !== undefined) return new TestError('ACTION_FAILED', slowRead);
        return new TestError('ACTION_FAILED', started.length < count
          ? `${count === 1 ? 'no download' : `${started.length} of ${count} downloads`} started within ${timeoutMs}ms; the trigger resolved after ${triggerMs}ms`
          : `${count === 1 ? 'the download' : `${count} downloads`} did not finish within ${timeoutMs}ms`);
      });
    } finally {
      offBegin();
      offEnd();
    }
  }

  /** Deletes the attempt's local download directory; files a wait saved are already copied out, and a remote one is the provider's. */
  dispose(): void {
    if (this.served === undefined) rmSync(this.dir, { recursive: true, force: true });
  }
}
