/**
 * Tabs in a real browser: a tab the app opens joins the tabs in the
 * background, `waitForPopup` and `switchTab` show one, when the shown tab
 * closes, the tab that opened it is shown again, and each tab keeps the keys
 * and buttons it holds and where its mouse is while another is shown.
 * Driven through the engine hooks the harness and the agent use, and the
 * `browser` fixture's tab calls.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestError, type EngineFixtureContext, type EngineHandle, type EngineSnapshot, type OperationContext } from '@e2e-dev/core/engine';
import type { Browser } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
import { byRole, cleanup, flatten, initInfo, onFirefox, operation as attemptOperation, testWeb } from '../helpers/web-session.ts';
import { gate } from '../helpers/gate.ts';

const PAGES: Readonly<Record<string, string>> = {
  '/opener': `<!doctype html><title>Opener</title><h1>Opener</h1>
    <button onclick="window.open('/popup', '_blank')">Open window</button>
    <a href="/popup" target="_blank">Open link</a>
    <button onclick="const tab = window.open('', '_blank'); tab.document.write('<title>Written</title><p>Code TAB-88421</p>'); tab.document.close();">Write tab</button>
    <a href="/slow" target="_blank">Open slow</a>
    <button onclick="window.open('/held', '_blank')">Open held</button>
    <a href="/hang" target="_blank">Open hang</a>
    <button onclick="window.open('/hang', '_blank')">Open hang window</button>
    <a href="/no-content" target="_blank">Open nothing</a>
    <a href="mailto:help@example.com" target="_blank">Email us</a>
    <a href="/export" target="_blank">Export</a>
    <button onclick="window.open('/popup', '_blank')">Open closable</button>`,
  '/popup': `<!doctype html><title>Popup</title><h1>Popup</h1>
    <button onclick="window.close()">Close me</button>
    <button onclick="window.open('/nested', '_blank')">Open nested</button>
    <button onclick="window.open('/slow', '_blank'); window.close();">Hand off</button>`,
  '/nested': '<!doctype html><title>Nested</title><h1>Nested</h1><button onclick="window.close()">Close nested</button>',
  '/slow': '<!doctype html><title>Slow</title><h1>Slow</h1>',
  '/held': '<!doctype html><title>Held</title><h1>Held</h1>',
  '/input': `<!doctype html><title>Input</title><h1>Input</h1><script>
    window.log = [];
    for (const type of ['keydown', 'keyup']) addEventListener(type, (event) => log.push(type + ' ' + event.key + (event.shiftKey ? ' shifted' : '')), true);
    addEventListener('mousedown', (event) => log.push('mousedown ' + event.clientX + ',' + event.clientY), true);
  </script>`,
};

const HEADING = byRole('heading');

/** An operation of the file's one attempt, on `timeoutMs` when a test gives one. */
function operation(timeoutMs?: number): OperationContext {
  return attemptOperation('t1', { timeoutMs });
}

describe('tabs', () => {
  let server: Server;
  let url: string;
  let artifactsDir: string;
  /** Requests for `/hang`, answered only when a test lets them go. */
  const hanging = new Set<ServerResponse>();
  /** The `/held` requests no test has served yet, and the serves no request has taken yet. */
  const held = { waiting: [] as ServerResponse[], served: 0 };
  /** Answers one `/held` request with its page. */
  const answerHeld = (response: ServerResponse): void => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(PAGES['/held']);
  };
  /** Serves the held page to one `/held` request: the one waiting longest, else the next to arrive. */
  const serveHeld = (): void => {
    const response = held.waiting.shift();
    if (response === undefined) held.served += 1;
    else answerHeld(response);
  };
  /** Opens the gate: requests for `/gate` are answered from then on, and held until then. */
  const { held: gateOpened, release: openGate } = gate();

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/hang') {
        hanging.add(response);
        return;
      }
      if (request.url === '/no-content') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.url === '/gate') {
        void gateOpened.then(() => response.end());
        return;
      }
      if (request.url === '/export') {
        response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="export.csv"' });
        response.end('a,b\n');
        return;
      }
      if (request.url === '/held') {
        if (held.served === 0) held.waiting.push(response);
        else {
          held.served -= 1;
          answerHeld(response);
        }
        return;
      }
      const page = PAGES[request.url ?? ''];
      if (request.url === '/slow') {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(page);
        }, 1_500);
        return;
      }
      response.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html' });
      response.end(page ?? '');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-tabs-'));
  });

  afterAll(async () => {
    for (const response of [...hanging, ...held.waiting]) response.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** Runs `body` on one engine in a running attempt opened at `/opener`, with the `browser` fixture. */
  async function withAttempt(body: (engine: EngineHandle, browser: Browser) => Promise<void>): Promise<void> {
    const engine = testWeb();
    await engine.init!(initInfo({ app: { site: '127.0.0.1' } }));
    await engine.startAttempt!({ attemptId: 't1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    try {
      const browser = engine.fixtures!['browser']!({
        operation,
        app: { resolveUrl: (target: string) => new URL(target, url).href },
        timeouts: { test: 30_000, assertion: 5_000 },
        expectable: (target: object) => target,
        fixture: (_name: string, target: object) => target,
        attachArtifact: () => undefined,
      } as unknown as EngineFixtureContext) as Browser;
      await engine.session!.open!(`${url}/opener`, operation());
      await body(engine, browser);
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  }

  /** Taps the node the current screen names `name`. */
  async function tap(engine: EngineHandle, name: string): Promise<void> {
    const node = flatten((await engine.observe!(operation())).root).find((candidate) => candidate.name === name);
    if (node === undefined) throw new Error(`no node named ${name} on the screen`);
    await engine.perform!(node.ref, { kind: 'tap' }, operation());
  }

  /** The screen's location and tabs, once its location ends with `suffix`. */
  async function screenAt(engine: EngineHandle, suffix: string): Promise<EngineSnapshot> {
    let snapshot: EngineSnapshot | undefined;
    await expect.poll(async () => {
      snapshot = await engine.observe!(operation());
      return snapshot.location ?? '';
    }, { timeout: 10_000 }).toMatch(new RegExp(`${suffix}$`));
    return snapshot!;
  }

  /** The screen once the attempt has `count` tabs open. */
  async function withTabs(engine: EngineHandle, count: number): Promise<EngineSnapshot> {
    let snapshot: EngineSnapshot | undefined;
    await expect.poll(async () => {
      snapshot = await engine.observe!(operation());
      return snapshot.tabs?.count ?? 1;
    }, { timeout: 10_000 }).toBe(count);
    return snapshot!;
  }

  /**
   * A `noopener` tab (a `target="_blank"` link) whose first response never comes stalls Chromium's BiDi mapper
   * (https://crbug.com/372842894): it holds every message after the tab's `contextCreated` until that response arrives.
   * The tap itself stalls, and the opener answers once the response ends.
   */
  async function stalledOnChromium(engine: EngineHandle, browser: Browser): Promise<void> {
    await expect(browser.waitForPopup(() => tap(engine, 'Open hang'), { timeout: 1_000 })).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: 'browser.waitForPopup exceeded its timeout of 1000ms',
    });
    let answered = false;
    const title = browser.title().finally(() => { answered = true; });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(answered).toBe(false);
    for (const response of hanging) response.end('<title>Late</title>');
    hanging.clear();
    expect(await title).toBe('Opener');
  }

  it('a tab the app opens stays in the background until it is switched to, and its close shows its opener', async () => {
    await withAttempt(async (engine) => {
      await tap(engine, 'Open window');
      const opened = await withTabs(engine, 2);
      expect(opened.location).toBe(`${url}/opener`);
      expect(opened.tabs).toEqual({ count: 2, active: 0 });
      await engine.session!.switchTab!(1, operation());
      expect((await screenAt(engine, '/popup')).tabs).toEqual({ count: 2, active: 1 });
      // The tap's only effect is closing the page it tapped on.
      await tap(engine, 'Close me');
      const back = await screenAt(engine, '/opener');
      expect(back.tabs).toBeUndefined();
    });
  });

  it('an operation after a tap that opens a slow tab runs on the opener at once; waitForPopup waits for the page', async () => {
    await withAttempt(async (engine, browser) => {
      await tap(engine, 'Open held');
      // Its page is not served yet, so this read waited for no page, and the tab has not joined.
      const before = await engine.observe!(operation());
      expect(before.location).toBe(`${url}/opener`);
      expect(before.tabs).toBeUndefined();
      // It joins in the background once its page loads.
      serveHeld();
      expect((await withTabs(engine, 2)).tabs).toEqual({ count: 2, active: 0 });
      const slow = await browser.waitForPopup(() => tap(engine, 'Open slow'));
      expect(await slow.url()).toBe(`${url}/slow`);
      expect((await engine.observe!(operation())).tabs).toEqual({ count: 3, active: 2 });
    });
  });

  // The wait must run out on the page, not on the trigger: its time covers the tap too, which takes Firefox about a second on a busy machine.
  const HANG_WAIT_MS = 5_000;
  for (const trigger of ['Open hang window', 'Open hang']) {
    it(`waitForPopup names the page a tab could not load when its time runs out, and the opener still answers (${trigger})`, async () => {
      await withAttempt(async (engine, browser) => {
        if (trigger === 'Open hang' && !onFirefox) return stalledOnChromium(engine, browser);
        await expect(browser.waitForPopup(() => tap(engine, trigger), { timeout: HANG_WAIT_MS })).rejects.toMatchObject({
          code: 'ACTION_FAILED',
          message: `the tab the app opened did not load ${url}/hang within ${String(HANG_WAIT_MS)}ms`,
        });
        expect(await browser.title()).toBe('Opener');
        for (const response of hanging) response.destroy();
        hanging.clear();
      });
    });
  }

  it('a tab whose opener closed itself before the tab loaded joins the tabs', async () => {
    await withAttempt(async (engine, browser) => {
      await browser.waitForPopup(() => tap(engine, 'Open window'));
      const orphan = await browser.waitForPopup(() => tap(engine, 'Hand off'));
      expect(await orphan.url()).toBe(`${url}/slow`);
      expect(orphan.isActive()).toBe(true);
      expect(browser.tabs()).toHaveLength(2);
      // It has no opener left, so its close hands the screen to the tab shown before it.
      await orphan.close();
      expect(await browser.url()).toBe(`${url}/opener`);
    });
  });

  it('a tab that never gets a document never joins the tabs', async () => {
    await withAttempt(async (engine, browser) => {
      const joined = [`${url}/opener`];
      for (const link of ['Open nothing', 'Email us', 'Export']) {
        await tap(engine, link);
        expect((await engine.observe!(operation())).location, link).toBe(`${url}/opener`);
        // A tab opened after it joins with its document, and the one that got none is not among the tabs then.
        await tap(engine, 'Open link');
        joined.push(`${url}/popup`);
        await expect.poll(() => Promise.all(browser.tabs().map((tab) => tab.url())), { message: link, timeout: 10_000 }).toEqual(joined);
      }
    });
  });

  it('reads in flight when the app closes the shown tab repeat on the tab shown next', async () => {
    await withAttempt(async (engine, browser) => {
      await browser.waitForPopup(() => tap(engine, 'Open closable'));
      await screenAt(engine, '/popup');
      // The tab closes itself once the gate opens: after a read of it came back, under the reads sent since.
      await browser.evaluate("() => { void fetch('/gate').then(() => window.close()); return null; }");
      // A retryable stale read is the runner's to repeat, as the locator engine does.
      const repeated = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
        try {
          return await read();
        } catch (cause) {
          expect(cause).toMatchObject({ code: 'NODE_STALE', retryable: true, message: 'the tab closed while it was read' });
          return undefined;
        }
      };
      const locations: string[] = [];
      try {
        while (locations.at(-1) !== `${url}/opener`) {
          const reads = Promise.all([
            repeated(() => engine.observe!(operation())),
            repeated(() => engine.locate!(HEADING, operation())),
          ]);
          if (locations.length > 0) openGate();
          const [snapshot] = await reads;
          if (snapshot !== undefined && snapshot.location !== locations.at(-1)) locations.push(snapshot.location ?? '');
        }
      } finally {
        openGate();
      }
      expect(locations).toEqual([`${url}/popup`, `${url}/opener`]);
    });
  });

  it('a target="_blank" link opens a tab, and a tab the app wrote with no navigation reads once switched to', async () => {
    await withAttempt(async (engine) => {
      await tap(engine, 'Open link');
      await withTabs(engine, 2);
      await tap(engine, 'Write tab');
      expect((await withTabs(engine, 3)).tabs).toEqual({ count: 3, active: 0 });
      await engine.session!.switchTab!(2, operation());
      await expect.poll(async () => flatten((await engine.observe!(operation())).root).some((node) => node.text === 'Code TAB-88421'), { timeout: 10_000 }).toBe(true);
      expect((await engine.observe!(operation())).tabs).toEqual({ count: 3, active: 2 });
    });
  });

  it('waitForPopup resolves with the tab once it is active; activate and close move between tabs', async () => {
    await withAttempt(async (_engine, browser) => {
      const popup = await browser.waitForPopup(async () => { await browser.evaluate("document.querySelector('a').click()"); });
      expect(popup.isActive()).toBe(true);
      expect(await popup.url()).toBe(`${url}/popup`);
      expect(await browser.url()).toBe(`${url}/popup`);
      const [opener, second] = browser.tabs();
      expect(second).toBe(popup);
      await opener!.activate();
      expect(await browser.title()).toBe('Opener');
      expect(popup.isActive()).toBe(false);
      await popup.activate();
      expect(await browser.title()).toBe('Popup');
      await popup.close();
      expect(popup.isClosed()).toBe(true);
      expect(opener!.isActive()).toBe(true);
      expect(await browser.url()).toBe(`${url}/opener`);
      expect(browser.tabs()).toEqual([opener]);
      await expect(popup.activate()).rejects.toMatchObject({ code: 'ACTION_FAILED' });
    });
  });

  it('waitForPopup fails the wait when no tab opens', async () => {
    await withAttempt(async (_engine, browser) => {
      await expect(browser.waitForPopup(async () => undefined, { timeout: 500 })).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        message: expect.stringMatching(/^no tab opened within 500ms/),
      });
      expect(browser.tabs()).toHaveLength(1);
    });
  });

  it('waitForPopup keeps a trigger error as the trigger threw it, classified or not', async () => {
    await withAttempt(async (_engine, browser) => {
      for (const failure of [new TestError('ASSERTION_FAILED', 'trigger assertion'), new Error('trigger broke')]) {
        await expect(browser.waitForPopup(async () => { throw failure; })).rejects.toBe(failure);
      }
      expect(browser.tabs()).toHaveLength(1);
    });
  });

  it('switchTab and closeTab take a tab by its place in opening order and refuse one that is not open', async () => {
    await withAttempt(async (engine) => {
      await tap(engine, 'Open window');
      await withTabs(engine, 2);
      await engine.session!.switchTab!(1, operation());
      expect((await screenAt(engine, '/popup')).tabs).toEqual({ count: 2, active: 1 });
      await expect(engine.session!.switchTab!(2, operation())).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        message: expect.stringContaining('there is no tab 3: 2 tabs are open'),
      });
      // Closing the tab on screen shows its opener.
      await engine.session!.closeTab!(1, operation());
      expect((await engine.observe!(operation())).location).toBe(`${url}/opener`);
      await expect(engine.session!.closeTab!(0, operation())).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        message: expect.stringContaining('tab 1 is the only open tab'),
      });
      // Closing a tab in the background leaves the screen where it is.
      await tap(engine, 'Open window');
      await withTabs(engine, 2);
      await engine.session!.closeTab!(1, operation());
      const after = await engine.observe!(operation());
      expect(after.location).toBe(`${url}/opener`);
      expect(after.tabs).toBeUndefined();
      // Two closes at once leave one tab open: the second sees the first.
      await tap(engine, 'Open window');
      await withTabs(engine, 2);
      const closes = await Promise.allSettled([engine.session!.closeTab!(1, operation()), engine.session!.closeTab!(0, operation())]);
      expect(closes.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
      expect((closes[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'ACTION_FAILED', message: expect.stringContaining('is the only open tab') });
      expect((await engine.observe!(operation())).location).toBe(`${url}/opener`);
    });
  });

  it('a tab closed out of order hands the screen to its nearest open opener', async () => {
    await withAttempt(async (engine, browser) => {
      const middle = await browser.waitForPopup(async () => { await browser.evaluate("document.querySelector('a').click()"); });
      const last = await browser.waitForPopup(async () => { await browser.evaluate("document.querySelectorAll('button')[1].click()"); });
      expect(await browser.url()).toBe(`${url}/nested`);
      // The tab in the middle closes in the background: the screen stays where it is.
      await middle.close();
      expect(last.isActive()).toBe(true);
      expect(browser.tabs()).toHaveLength(2);
      // The shown tab closes and its opener is gone: the screen returns to the opener's opener.
      await tap(engine, 'Close nested');
      await screenAt(engine, '/opener');
      expect(browser.tabs()).toHaveLength(1);
    });
  });

  it('newTab opens a blank tab in the same context and shows it', async () => {
    await withAttempt(async (_engine, browser) => {
      await browser.evaluate("document.cookie = 'shared=yes'");
      const tab = await browser.newTab();
      expect(tab.isActive()).toBe(true);
      expect(await browser.url()).toBe('about:blank');
      await browser.goto('/nested');
      expect(await browser.evaluate('document.cookie')).toBe('shared=yes');
      expect(browser.tabs()).toHaveLength(2);
    });
  });

  it('a tab keeps the keys it holds and where its mouse is while another tab is shown, and the other tab has neither', async () => {
    await withAttempt(async (_engine, browser) => {
      /** The input events the shown tab logged since they were last read. */
      const logged = (): Promise<string[]> => browser.evaluate<string[]>('window.log.splice(0)');
      const [first] = browser.tabs();
      await browser.goto('/input');
      await browser.keyboard.down('Shift');
      await browser.mouse.move(100, 120);
      expect(await logged()).toEqual(['keydown Shift shifted']);
      const second = await browser.newTab();
      await browser.goto('/input');
      await browser.keyboard.press('a');
      await browser.mouse.move(30, 40);
      await browser.mouse.down();
      await browser.mouse.up();
      expect(await logged()).toEqual(['keydown a', 'keyup a', 'mousedown 30,40']);
      await first!.activate();
      // Shift is still down here: a chord with it neither presses nor releases it, and the mouse presses where it was left.
      await browser.keyboard.press('Shift+b');
      await browser.keyboard.press('a');
      await browser.mouse.down();
      await browser.mouse.up();
      await browser.keyboard.up('Shift');
      await browser.keyboard.press('a');
      expect(await logged()).toEqual(['keydown B shifted', 'keyup B shifted', 'keydown A shifted', 'keyup A shifted', 'mousedown 100,120', 'keyup Shift', 'keydown a', 'keyup a']);
      await second.activate();
      await browser.mouse.down();
      await browser.mouse.up();
      expect(await logged()).toEqual(['mousedown 30,40']);
    });
  });

  it('the video keeps a segment per tab shown and drops the one a tab that closed itself could not flush', async () => {
    await withAttempt(async (engine, browser) => {
      await engine.artifacts!.startVideo!(operation());
      await browser.waitForPopup(() => tap(engine, 'Open window'));
      await screenAt(engine, '/popup');
      await tap(engine, 'Close me');
      await screenAt(engine, '/opener');
      const segments = await engine.artifacts!.stopVideo!(operation());
      const files = segments.map((segment) => ('path' in segment ? segment.path : segment.url));
      expect(files[0]).toBe('video/video.webm');
      expect(files.at(-1)).toBe('video/video-part3.webm');
      for (const file of files) {
        const absolute = path.join(artifactsDir, file);
        expect(existsSync(absolute), file).toBe(true);
        expect(statSync(absolute).size).toBeGreaterThan(0);
      }
    });
  });
});
