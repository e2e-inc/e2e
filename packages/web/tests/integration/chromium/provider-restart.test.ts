/**
 * A restart in a leased browser's own context, against a real Chrome over
 * CDP: the blank tab opens before the old ones close, so the browser is
 * never without a page. A Chrome that exits with its last window would end
 * an attempt-scoped lease in the middle of the restart.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineHandle } from '@e2e-dev/core/engine';
import { web, type BrowserProvider } from '../../../src/index.ts';
import { launchRemoteChrome, tearDownRemote, type RemoteChrome } from '../../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../../helpers/secrets.ts';
import { cleanup, initInfo, operation } from '../../helpers/web-session.ts';

/** A target event of Chrome's, as its DevTools connection sends it. */
interface TargetEvent {
  readonly method?: string;
  readonly params?: { readonly targetId?: string; readonly targetInfo?: { readonly targetId: string; readonly type: string } };
}

/**
 * Counts Chrome's open pages over a DevTools connection of its own: how
 * many are open now, and the fewest left open by a page closing.
 */
async function watchPages(endpoint: string): Promise<{ open(): number; fewest(): number; close(): void }> {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`no DevTools connection to ${endpoint}`)), { once: true });
  });
  const pages = new Set<string>();
  let fewest = Number.POSITIVE_INFINITY;
  socket.addEventListener('message', (message) => {
    const event = JSON.parse(String(message.data)) as TargetEvent;
    if (event.method === 'Target.targetCreated' && event.params?.targetInfo?.type === 'page') pages.add(event.params.targetInfo.targetId);
    if (event.method === 'Target.targetDestroyed' && pages.delete(event.params?.targetId ?? '')) fewest = Math.min(fewest, pages.size);
  });
  socket.send(JSON.stringify({ id: 1, method: 'Target.setDiscoverTargets', params: { discover: true } }));
  return { open: () => pages.size, fewest: () => fewest, close: () => socket.close() };
}

describe('a restart in a leased browser’s own context', () => {
  let app: FixtureApp;
  let chrome: RemoteChrome;
  let artifactsDir: string;
  let engine: EngineHandle | undefined;
  const run = { runId: 'run-restart', targetName: 'web', env: {}, log: () => undefined };

  beforeAll(async () => {
    app = await startFixtureApp();
    chrome = await launchRemoteChrome();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-restart-'));
  }, 60_000);

  afterAll(async () => {
    await tearDownRemote({
      ends: [
        () => engine?.endAttempt!(cleanup(10_000)),
        () => engine?.dispose!(cleanup(10_000)),
        () => engine?.finish!({ ...run, ...cleanup(10_000) }),
      ],
      chrome,
      closes: [() => app?.close()],
      directories: [artifactsDir],
    });
  });

  it('never leaves the browser without a page, and reopens the app in the new one', async () => {
    const provider: BrowserProvider = {
      name: 'toy-remote',
      scope: 'attempt',
      acquire: async () => ({ id: 'lease-1', cdpEndpoint: chrome.endpoint }),
      release: async () => undefined,
    };
    engine = web({ browser: provider });
    const prepared = await engine.prepare!({ ...run, projectRoot: process.cwd(), app: { site: new URL(app.url).hostname }, slots: 1, signal: new AbortController().signal, headed: false });
    const pages = await watchPages(chrome.endpoint);
    try {
      await engine.init!(initInfo({ runId: run.runId, app: { site: new URL(app.url).hostname }, env: { ...prepared?.env } }));
      await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
      const step = () => operation('a1', { runId: run.runId });
      await engine.session!.open!(`${app.url}/state`, step());
      await expect.poll(() => pages.open()).toBe(2);

      await engine.session!.restart!(step());
      await expect.poll(() => pages.open()).toBe(1);
      expect(pages.fewest()).toBe(1);
      expect(chrome.proc.exitCode).toBeNull();
      expect((await engine.observe!(step())).location).toBe('about:blank');
      await engine.session!.open!(`${app.url}/state`, step());
      expect((await engine.observe!(step())).location).toBe(`${app.url}/state`);
    } finally {
      pages.close();
    }
  }, 60_000);
});
