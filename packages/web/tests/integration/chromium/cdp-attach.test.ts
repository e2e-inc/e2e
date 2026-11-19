/**
 * The CDP-attach seam end to end: a real Chrome is launched out-of-band with
 * remote debugging, the engine attaches to it through `connect.cdpEndpoint`
 * instead of launching its own, drives a full attempt over that connection,
 * and on dispose detaches without killing the remote the host owns. This is
 * the exact shape a hosted-browser engine (a per-run cloud session) uses.
 */

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EngineHandle } from '@e2e-dev/core/engine';
import { web } from '../../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../../helpers/fixture-app.ts';
import { closeRemoteChrome, debuggerUrl, launchRemoteChrome, recordGoodbyes, tearDownRemote, type RemoteChrome } from '../../helpers/cdp-host.ts';
import { ignoreTrace, noSecrets } from '../../helpers/secrets.ts';
import { byRole, cleanup, initInfo, operation } from '../../helpers/web-session.ts';

describe('web engine over CDP', () => {
  let app: FixtureApp;
  let chrome: RemoteChrome;
  let artifactsDir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    chrome = await launchRemoteChrome();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-cdp-artifacts-'));
  }, 60_000);

  afterAll(async () => {
    await tearDownRemote({ chrome, closes: [() => app?.close()], directories: [artifactsDir] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches to the remote, drives an attempt, and detaches on dispose without killing it', async () => {
    const goodbyes = recordGoodbyes();
    let resolved = 0;
    const engine: EngineHandle = web({
      connect: {
        cdpEndpoint: () => {
          resolved += 1;
          return chrome.endpoint;
        },
      },
    });

    await engine.init!(initInfo({ app: { site: new URL(app.url).hostname } }));
    expect(resolved).toBe(1);

    try {
      await engine.startAttempt!({ attemptId: 'a1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
      await engine.session!.open!(`${app.url}/`, operation('a1'));
      const headings = await engine.locate!(
        byRole('heading'),
        operation('a1'),
      );
      // Proof the attempt ran over the attached remote, not a local launch.
      expect(headings[0]?.name).toBe('Home');
      expect((await engine.observe!(operation('a1'))).location).toBe(`${app.url}/`);
      await engine.endAttempt!(cleanup());
    } finally {
      await engine.dispose!(cleanup());
    }

    // Dispose ends its session and closes no browser: the remote the host owns still answers.
    expect(goodbyes()).toEqual(['session.end']);
    expect(await debuggerUrl(chrome)).toBe(chrome.endpoint);
  }, 60_000);

  it('reacquires a dropped remote at the next attempt by resolving the endpoint again', async () => {
    let current = chrome;
    let resolved = 0;
    const engine: EngineHandle = web({
      connect: {
        cdpEndpoint: () => {
          resolved += 1;
          return current.endpoint;
        },
      },
    });
    await engine.init!(initInfo({ app: { site: new URL(app.url).hostname } }));
    try {
      await engine.startAttempt!({ attemptId: 'r1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
      await engine.session!.open!(`${app.url}/`, operation('r1'));
      await engine.endAttempt!(cleanup());
      expect(resolved).toBe(1);

      // The host's session goes away: kill the remote and stand up a fresh one
      // at a new endpoint, the way a per-run cloud session is re-provisioned.
      await closeRemoteChrome(chrome);
      expect(existsSync(chrome.userDataDir)).toBe(false);
      const replacement = await launchRemoteChrome();
      current = replacement;
      chrome = replacement;

      // The next attempt must not fail on the dead browser: it reacquires,
      // running the resolver again, and works over the new session.
      await engine.startAttempt!({ attemptId: 'r2', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
      expect(resolved).toBe(2);
      await engine.session!.open!(`${app.url}/`, operation('r2'));
      const headings = await engine.locate!(
        byRole('heading'),
        operation('r2'),
      );
      expect(headings[0]?.name).toBe('Home');
      await engine.endAttempt!(cleanup());
    } finally {
      await engine.dispose!(cleanup());
    }
  }, 90_000);

  it('never caches a browser that connects after the init was cancelled', async () => {
    const goodbyes = recordGoodbyes();
    let resolved = 0;
    const controller = new AbortController();
    const engine: EngineHandle = web({
      connect: {
        cdpEndpoint: () => {
          resolved += 1;
          // Cancel right after the endpoint is handed back, so the attach
          // completes into an already-aborted init.
          queueMicrotask(() => controller.abort());
          return chrome.endpoint;
        },
      },
    });
    const site = new URL(app.url).hostname;
    await expect(engine.init!(initInfo({ app: { site }, signal: controller.signal }))).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(resolved).toBe(1);

    // A fresh init must provision again. Were the late browser cached, the pool
    // would hand it back without consulting the resolver.
    await engine.init!(initInfo({ app: { site } }));
    try {
      expect(resolved).toBe(2);
    } finally {
      await engine.dispose!(cleanup());
    }
    // And the remote the host owns was detached, not killed.
    expect(goodbyes()).not.toContain('browser.close');
    expect(await debuggerUrl(chrome)).toBe(chrome.endpoint);
  }, 60_000);
});
