/**
 * A provider that serves downloads, against a real Chrome over CDP: the
 * browser saves the file to the provider's directory on its own disk, not
 * the engine's on the runner's, and `waitForDownload` gets it back through
 * the provider's `read`. A hosted browser needs exactly this, since the
 * runner's directory does not exist on its machine; here the "remote" disk
 * is a local directory the provider reads. A provider that serves none
 * refuses the wait before its trigger runs.
 */

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { EngineHandle, OperationContext } from '@e2e-dev/core/engine';
import { web as webEngine, type BrowserProvider, type BrowserProviderScope } from '../../../src/index.ts';
import { launchRemoteChrome, tearDownRemote, type RemoteChrome } from '../../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../../helpers/secrets.ts';
import { browserFixture, bySelector, cleanup, initInfo, operation as attemptOperation } from '../../helpers/web-session.ts';

/** An operation of the file's one attempt, on a 15 s budget. */
function operation(): OperationContext {
  return attemptOperation('a1', { timeoutMs: 15_000, runId: 'run-downloads' });
}

const signal = () => new AbortController().signal;

/** Taps the one node `selector` locates in `engine`'s page. */
async function tap(engine: EngineHandle, selector: string): Promise<void> {
  const [node] = await engine.locate!(bySelector(selector), operation());
  await engine.perform!(node!.ref, { kind: 'tap' }, operation());
}

/** Adds `count` links to the page, each downloading `report-<n>.txt` with `body` and its index, or `name` when given. */
async function addDownloadLinks(engine: EngineHandle, baseUrl: string, count: number, body: string, name?: string): Promise<void> {
  await browserFixture(engine, { baseUrl }).evaluate(({ total, text, file }: { total: number; text: string; file: string | null }) => {
    for (let index = 0; index < total; index += 1) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([file === null ? `${text} ${index}` : text]));
      link.download = file ?? `report-${index}.txt`;
      link.id = file === null ? `download-${index}` : 'download';
      link.textContent = 'Download';
      document.body.append(link);
    }
    return null;
  }, { total: count, text: body, file: name ?? null });
}

describe.each<BrowserProviderScope>(['worker', 'attempt'])('downloads through a provider, %s scope', (scope) => {
  let app: FixtureApp;
  let artifactsDir: string | undefined;
  let remoteDisk: string | undefined;
  let chrome: RemoteChrome | undefined;
  let engine: EngineHandle | undefined;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    const ending = { engine, chrome, directories: [artifactsDir, remoteDisk] };
    engine = chrome = artifactsDir = remoteDisk = undefined;
    await tearDownRemote({
      ends: [
        () => ending.engine?.endAttempt!(cleanup(10_000)),
        () => ending.engine?.dispose!(cleanup(10_000)),
        () => ending.engine?.finish!({ runId: 'run-downloads', targetName: 'web', env: {}, log: () => undefined, ...cleanup(10_000) }),
      ],
      chrome: ending.chrome,
      directories: ending.directories,
    });
  });

  it.each([1, 2])('saves %i files on the browser disk through one trigger', async (count) => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-downloads-'));
    remoteDisk = mkdtempSync(path.join(tmpdir(), 'e2e-browser-disk-'));
    chrome = await launchRemoteChrome();
    const reads: { lease: string; file: string; suggestedFilename: string; body: string }[] = [];
    const provider: BrowserProvider = {
      name: 'toy-remote',
      scope,
      acquire: async () => ({ id: 'lease-1', cdpEndpoint: chrome!.endpoint }),
      release: async () => undefined,
      downloads: {
        dir: path.join(remoteDisk, 'downloads'),
        async read(lease, file, { suggestedFilename }) {
          const bytes = await readFile(file);
          reads.push({ lease: lease.id, file, suggestedFilename, body: bytes.toString('utf8') });
          return bytes;
        },
      },
    };
    engine = webEngine({ browser: provider });
    const prepared = await engine.prepare!({ runId: 'run-downloads', targetName: 'web', projectRoot: process.cwd(), app: { site: new URL(app.url).hostname }, slots: 1, env: {}, signal: signal(), headed: false, log: () => undefined });
    await engine.init!(initInfo({ runId: 'run-downloads', app: { site: new URL(app.url).hostname }, env: { ...prepared?.env } }));
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: signal(), resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!(`${app.url}/login`, operation());
    await addDownloadLinks(engine, app.url, count, 'report body');
    const attached: string[] = [];
    const browser = browserFixture(engine, { baseUrl: app.url, operation: () => operation(), attach: (relative) => attached.push(relative) });

    let triggers = 0;
    const trigger = async (): Promise<void> => {
      triggers += 1;
      for (let index = 0; index < count; index += 1) await tap(engine!, `#download-${index}`);
    };
    const files = count === 1
      ? [await browser.waitForDownload(trigger)]
      : await browser.waitForDownloads(trigger, { count });
    expect(triggers).toBe(1);
    expect(files).toHaveLength(count);
    for (const [index, file] of files.entries()) {
      expect(file.suggestedFilename).toBe(`report-${index}.txt`);
      expect(path.isAbsolute(file.absolutePath)).toBe(true);
      expect(file.absolutePath).toBe(path.join(artifactsDir, file.path));
      expect(readFileSync(file.absolutePath, 'utf8')).toBe(`report body ${index}`);
      expect(file.path).toMatch(/^downloads\/\d{3}-report-\d\.txt$/);
    }
    expect(attached).toEqual(files.map(file => file.path));
    expect(reads).toHaveLength(count);
    // Each read is told the name of the file it reads, for a service that finds a download by name.
    expect(reads.map(read => [read.suggestedFilename, read.body]).toSorted()).toEqual(files.map((_, index) => [`report-${index}.txt`, `report body ${index}`]));
    expect(reads.every(read => read.lease === 'lease-1')).toBe(true);
    expect(reads.every(read => path.dirname(read.file) === path.join(remoteDisk!, 'downloads'))).toBe(true);
    expect(readdirSync(path.join(remoteDisk, 'downloads')).toSorted()).toEqual(reads.map(read => path.basename(read.file)).toSorted());
  });

  it('keeps no file of a wait whose provider fails to read a later download back', async () => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-partial-'));
    remoteDisk = mkdtempSync(path.join(tmpdir(), 'e2e-browser-partial-'));
    chrome = await launchRemoteChrome();
    let reads = 0;
    const provider: BrowserProvider = {
      name: 'failing-remote', scope,
      acquire: async () => ({ id: 'failing-lease', cdpEndpoint: chrome!.endpoint }),
      release: async () => undefined,
      downloads: {
        dir: path.join(remoteDisk, 'downloads'),
        async read(_lease, file) {
          reads += 1;
          if (reads === 2) throw new Error('provider read broke');
          return readFile(file);
        },
      },
    };
    engine = webEngine({ browser: provider });
    const prepared = await engine.prepare!({ runId: 'run-downloads', targetName: 'web', projectRoot: process.cwd(), app: { site: new URL(app.url).hostname }, slots: 1, env: {}, signal: signal(), headed: false, log: () => undefined });
    await engine.init!(initInfo({ runId: 'run-downloads', app: { site: new URL(app.url).hostname }, env: { ...prepared?.env } }));
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: signal(), resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!(`${app.url}/login`, operation());
    await addDownloadLinks(engine, app.url, 2, 'report body');
    const attached: string[] = [];
    const browser = browserFixture(engine, { baseUrl: app.url, operation: () => operation(), attach: (relative) => attached.push(relative) });
    const trigger = async (): Promise<void> => {
      for (let index = 0; index < 2; index += 1) await tap(engine!, `#download-${index}`);
    };
    await expect(browser.waitForDownloads(trigger, { count: 2 })).rejects.toThrow('provider read broke');
    expect(reads).toBe(2);
    expect(attached).toEqual([]);
    expect(readdirSync(artifactsDir, { recursive: true, encoding: 'utf8' }).filter((entry) => entry.startsWith('downloads'))).toEqual([]);
  });

  it('saves a download of a provider without downloads whose browser runs on this machine', async () => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-unserved-'));
    chrome = await launchRemoteChrome();
    const provider: BrowserProvider = {
      name: 'toy-unserved', scope,
      acquire: async () => ({ id: 'lease-1', cdpEndpoint: chrome!.endpoint }),
      release: async () => undefined,
    };
    engine = webEngine({ browser: provider });
    const prepared = await engine.prepare!({ runId: 'run-downloads', targetName: 'web', projectRoot: process.cwd(), app: { site: new URL(app.url).hostname }, slots: 1, env: {}, signal: signal(), headed: false, log: () => undefined });
    await engine.init!(initInfo({ runId: 'run-downloads', app: { site: new URL(app.url).hostname }, env: { ...prepared?.env } }));
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: signal(), resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!(`${app.url}/login`, operation());
    await addDownloadLinks(engine, app.url, 1, 'report body');
    const browser = browserFixture(engine, { baseUrl: app.url, operation: () => operation() });
    const file = await browser.waitForDownload(() => tap(engine!, '#download-0'));
    expect(file.suggestedFilename).toBe('report-0.txt');
    expect(readFileSync(file.absolutePath, 'utf8')).toBe('report body 0');
  });

  it.each(['waitForDownload', 'waitForDownloads'] as const)('%s bounds a completed download whose provider read stalls', async (method) => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-stalled-'));
    remoteDisk = mkdtempSync(path.join(tmpdir(), 'e2e-browser-stalled-'));
    chrome = await launchRemoteChrome();
    let readSignal: AbortSignal | undefined;
    const provider: BrowserProvider = {
      name: 'stalled-remote', scope,
      acquire: async () => ({ id: 'stalled-lease', cdpEndpoint: chrome!.endpoint }),
      release: async () => undefined,
      downloads: {
        dir: path.join(remoteDisk, 'downloads'),
        async read(_lease, file, { signal: readCancellation }) {
          expect((await readFile(file)).toString()).toBe('stalled provider body');
          readSignal = readCancellation;
          return new Promise<Uint8Array>((_resolve, reject) => {
            if (readCancellation.aborted) reject(new Error('provider read canceled'));
            else readCancellation.addEventListener('abort', () => reject(new Error('provider read canceled')), { once: true });
          });
        },
      },
    };
    engine = webEngine({ browser: provider });
    const prepared = await engine.prepare!({ runId: 'run-downloads', targetName: 'web', projectRoot: process.cwd(), app: { site: new URL(app.url).hostname }, slots: 1, env: {}, signal: signal(), headed: false, log: () => undefined });
    await engine.init!(initInfo({ runId: 'run-downloads', app: { site: new URL(app.url).hostname }, env: { ...prepared?.env } }));
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: signal(), resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!(app.url, operation());
    await addDownloadLinks(engine, app.url, 1, 'stalled provider body', 'report.txt');
    const attached: string[] = [];
    const browser = browserFixture(engine, {
      baseUrl: app.url,
      operation: (timeout?: number) => ({ ...operation(), timeoutMs: timeout ?? 15000 }),
      attach: (relative) => attached.push(relative),
    });
    const trigger = () => tap(engine!, '#download');
    const work = method === 'waitForDownload'
      ? browser.waitForDownload(trigger, { timeout: 500 })
      : browser.waitForDownloads(trigger, { count: 1, timeout: 500 });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work.then(() => ({ code: 'completed', message: '' }), (error: { code: string; message: string }) => error),
        new Promise<{ code: string; message: string }>((resolve) => { watchdog = setTimeout(() => resolve({ code: 'still pending', message: '' }), 1500); }),
      ]);
      expect(readSignal).toBeDefined();
      expect(result).toMatchObject({ code: 'ACTION_FAILED', message: 'download report.txt did not finish: browser provider "stalled-remote" read it back too slowly' });
      expect(readSignal?.aborted).toBe(true);
      expect(attached).toEqual([]);
    } finally { clearTimeout(watchdog); }
  });
});
