/**
 * Uploads to a browser provider's browser, against a real Chrome over CDP:
 * its filesystem is another machine's, so the engine sends the files' bytes
 * into the page instead of their paths, and the page's input gets the same
 * files, names, types, and events a person picking them would give it.
 */

import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EngineHandle, JsonValue, OperationContext } from '@e2e-dev/core/engine';
import { web as webEngine, type BrowserProvider } from '../../../src/index.ts';
import { launchRemoteChrome, tearDownRemote, type RemoteChrome } from '../../helpers/cdp-host.ts';
import { startFixtureApp, type FixtureApp } from '../../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../../helpers/secrets.ts';
import { browserFixture, bySelector, cleanup, initInfo, operation as attemptOperation } from '../../helpers/web-session.ts';

/** An operation of the file's one attempt, on a 15 s budget. */
function operation(): OperationContext {
  return attemptOperation('a1', { timeoutMs: 15_000, runId: 'run-uploads' });
}

const signal = () => new AbortController().signal;

/**
 * Records every change of each file input on the page: the files' names,
 * types, and text, and the events that fired. A change is recorded once its
 * files are read, and `reading` holds every read begun.
 */
const PAGE = `<input type="file" id="many" multiple>
<input type="file" id="one">
<input type="file" id="hidden" style="display:none">
<button id="pick" onclick="document.getElementById('hidden').click()">Pick</button>
<script>
  window.seen = [];
  window.reading = [];
  for (const input of document.querySelectorAll('input[type=file]')) {
    input.addEventListener('input', (event) => window.seen.push({ id: input.id, event: event.type, composed: event.composed }));
    input.addEventListener('change', () => {
      const files = Promise.all([...input.files].map(async (file) => ({ name: file.name, type: file.type, text: await file.text() })));
      window.reading.push(files.then((read) => window.seen.push({ id: input.id, event: 'change', files: read })));
    });
  }
</script>`;

describe('uploads to a provider\'s browser', () => {
  let app: FixtureApp;
  let chrome: RemoteChrome;
  let engine: EngineHandle;
  let dir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-provider-uploads-'));
    writeFileSync(path.join(dir, 'notes.txt'), 'plain notes');
    writeFileSync(path.join(dir, 'data.json'), '{"ok":true}');
    mkdirSync(path.join(dir, 'folder'));
    writeFileSync(path.join(dir, 'folder', 'inside.txt'), 'inside');
    writeFileSync(path.join(dir, 'huge.bin'), '');
    truncateSync(path.join(dir, 'huge.bin'), 50 * 1024 * 1024 + 1);
    chrome = await launchRemoteChrome();
    const provider: BrowserProvider = {
      name: 'toy-remote',
      scope: 'worker',
      acquire: async () => ({ id: 'lease-1', cdpEndpoint: chrome.endpoint }),
      release: async () => undefined,
    };
    engine = webEngine({ browser: provider });
    const prepared = await engine.prepare!({ runId: 'run-uploads', targetName: 'web', projectRoot: dir, app: { site: new URL(app.url).hostname }, slots: 1, env: {}, signal: signal(), headed: false, log: () => undefined });
    await engine.init!(initInfo({ runId: 'run-uploads', projectRoot: dir, app: { site: new URL(app.url).hostname }, env: { ...prepared?.env } }));
  });

  afterAll(async () => {
    await tearDownRemote({
      ends: [
        () => engine?.dispose!(cleanup(10_000)),
        () => engine?.finish!({ runId: 'run-uploads', targetName: 'web', env: {}, log: () => undefined, ...cleanup(10_000) }),
      ],
      chrome,
      closes: [() => app?.close()],
      directories: [dir],
    });
  });

  afterEach(async () => {
    await engine.endAttempt!(cleanup(10_000));
  });

  /** Starts an attempt on the recording page. */
  async function open(): Promise<void> {
    await engine.startAttempt!({ attemptId: 'a1', artifactsDir: mkdtempSync(path.join(dir, 'artifacts-')), signal: signal(), resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!(`${app.url}/login`, operation());
    await browserFixture(engine, { baseUrl: app.url }).evaluate((html: string) => {
      document.body.innerHTML = html;
      for (const script of document.body.querySelectorAll('script')) {
        const live = document.createElement('script');
        live.textContent = script.textContent;
        script.replaceWith(live);
      }
      return null;
    }, PAGE);
  }

  /** Uploads `paths` through the node `selector` locates, and the error it failed with, if any. */
  async function upload(selector: string, paths: string[]): Promise<unknown> {
    const [node] = await engine.locate!(bySelector(selector), operation());
    return engine.perform!(node!.ref, { kind: 'setInputFiles', paths }, operation()).then(() => undefined, (error: unknown) => error);
  }

  /** What the page recorded, once it read the files of every change fired so far. */
  const seen = () => browserFixture(engine, { baseUrl: app.url }).evaluate(async () => {
    const recorded = window as unknown as { seen: JsonValue[]; reading: Promise<unknown>[] };
    await Promise.all(recorded.reading);
    return recorded.seen;
  });

  it('sends the files\' bytes, names, and types, and fires input and change as a pick does', async () => {
    await open();
    expect(await upload('#many', ['notes.txt', path.join(dir, 'data.json')])).toBeUndefined();
    expect(await seen()).toEqual([
      { id: 'many', event: 'input', composed: true },
      { id: 'many', event: 'change', files: [{ name: 'notes.txt', type: 'text/plain', text: 'plain notes' }, { name: 'data.json', type: 'application/json', text: '{"ok":true}' }] },
    ]);
  });

  it('serves the input a button\'s file chooser opens', async () => {
    await open();
    expect(await upload('#pick', ['notes.txt'])).toBeUndefined();
    expect(await seen()).toEqual(expect.arrayContaining([
      { id: 'hidden', event: 'change', files: [{ name: 'notes.txt', type: 'text/plain', text: 'plain notes' }] },
    ]));
  });

  it('refuses two files for an input that takes one, a directory, and more bytes than it sends, and changes nothing', async () => {
    await open();
    expect(await upload('#one', ['notes.txt', 'data.json'])).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'Non-multiple file input can only accept single file' });
    expect(await upload('#many', ['folder'])).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('a directory cannot be sent') });
    expect(await upload('#many', ['huge.bin'])).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('the limit is 52428800') });
    expect(await seen()).toEqual([]);
  });
});
