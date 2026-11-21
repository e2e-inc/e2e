/**
 * `revylWeb()` against a scripted Revyl API: the options it refuses, the
 * session lifecycle, how the Maestro hierarchy and CSS queries become nodes,
 * and how actions and their failures reach the runner.
 */

import { EngineError, type EngineHandle, type LocatorExpression, type OperationContext, type SemanticNode } from '@e2e-dev/core/engine';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revylWeb } from '../../src/web.ts';
import { markSelector, type MaestroNode } from '../../src/web/tree.ts';

const APP = 'app-1';
const roleCss = (role: string): string => markSelector({ kind: 'role', role });
const CHECKED = markSelector({ kind: 'state', state: 'checked' });
const FIELD = markSelector({ kind: 'field' });
const DISABLED = markSelector({ kind: 'state', state: 'disabled' });
const RUN = 'run-1';

function node(text: string, [left, top, right, bottom]: number[], children: MaestroNode[] = [], id?: string): MaestroNode {
  return { attributes: { text, bounds: { left: left!, top: top!, right: right!, bottom: bottom! }, ...(id === undefined ? {} : { 'resource-id': id }) }, children };
}

const input = node('What needs to be done?', [100, 100, 500, 140]);
const save = node('', [100, 200, 180, 240], [node('Save', [110, 210, 170, 230])]);
const hidden = node('Delete', [0, 0, 0, 0], [], 'delete');
const page = (): MaestroNode => node('', [0, 0, 1280, 800], [node('', [0, 0, 1280, 800], [input, save, hidden])]);

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

let calls: Call[];
let tree: () => MaestroNode;
let queries: Record<string, MaestroNode[]>;
let actionResult: { status: number; body: unknown };
let info: { width_pixels: number; height_pixels: number; width_grid: number; height_grid: number };
let tabs: unknown[];
let failingReads: number;
let delays: Record<string, number>;

beforeEach(() => {
  calls = [];
  tree = page;
  queries = { ':placeholder-shown': [input] };
  actionResult = { status: 200, body: { success: true, action: 'tap', latency_ms: 1 } };
  info = { width_pixels: 1280, height_pixels: 800, width_grid: 1280, height_grid: 800 };
  failingReads = 0;
  delays = {};
  tabs = [{ tab_id: 't', active: true, url_origin: 'https://example.com', route_pattern: '/', url_path: '/todos' }];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? 'GET', path, body });
    const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status });
    if (path === `/api/v1/apps/${APP}/builds/external`) return json({ id: 'build-1' });
    if (path === '/api/v1/execution/start_device') return json({ session_id: (body as { session_id: string }).session_id, workflow_run_id: RUN });
    if (path.startsWith('/api/v1/execution/device-sessions/')) return json({ status: 'running', workflow_run_id: RUN, viewer_kind: 'whep' });
    if (path.endsWith('/stop')) return json({ success: true });
    const action = path.split(`/device-proxy/${RUN}/`)[1];
    const delay = action === undefined ? undefined : delays[action];
    if (delay !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      });
    }
    if (action === 'maestro_web_info') return json(info);
    if (action === 'maestro_web_hierarchy') {
      if (failingReads > 0) {
        failingReads -= 1;
        return new Response('Web worker lookup is unavailable', { status: 503 });
      }
      return json(tree());
    }
    if (action === 'tabs') return json(tabs);
    if (action === 'maestro_web_query') return json({ nodes: queries[(body as { css: string }).css] ?? [] });
    return json(actionResult.body, actionResult.status);
  });
});

afterEach(() => vi.unstubAllGlobals());

/** Wraps the scripted API so a `tab_close` call also runs `onClose`. */
function wrapClose(inner: typeof fetch, onClose: () => void): typeof fetch {
  return async (url, init) => {
    if (String(url).endsWith('/tab_close')) onClose();
    return inner(url, init);
  };
}

const context = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 10_000, runId: 'r', attemptId: 'a', origin: 'test' });

/** What the runner hands `init`. */
const initInfo = (signal: AbortSignal = new AbortController().signal) => ({
  runId: 'r',
  targetName: 'web',
  projectRoot: '/project',
  app: { origin: 'https://example.com' },
  env: { REVYL_API_KEY: 'key' },
  headed: false,
  workerSlot: 0,
  signal,
  log: () => undefined,
});

async function started(options: Partial<Parameters<typeof revylWeb>[0]> = {}): Promise<EngineHandle> {
  const engine = revylWeb({ app: APP, ...options });
  await engine.init!(initInfo());
  return engine;
}

/** Runs `init` expecting it to fail, then `dispose`, and returns the start request's session id and the stops sent for it. */
async function failedStart(pattern: RegExp): Promise<number> {
  const engine = revylWeb({ app: APP });
  await expect(engine.init!(initInfo())).rejects.toThrow(pattern);
  const request = calls.find((call) => call.path === '/api/v1/execution/start_device')?.body as { session_id: string } | undefined;
  const before = calls.length;
  await engine.dispose!({ signal: new AbortController().signal, timeoutMs: 1_000 });
  return calls.slice(before).filter((call) => request !== undefined && call.path === `/api/v1/execution/device/sessions/${request.session_id}/stop`).length;
}

const role = (value: string, name?: string): LocatorExpression => ({
  kind: 'query',
  query: { kind: 'role', value: { kind: 'string', value, exact: true }, ...(name === undefined ? {} : { name: { kind: 'string', value: name, exact: true } }) },
});

describe('revylWeb()', () => {
  it('refuses a config without an app, with a bad start URL, or with a device app', () => {
    expect(() => revylWeb({ app: '' })).toThrow(/`app` is required/);
    expect(() => revylWeb({ app: APP, startUrl: 'file:///etc/passwd' })).toThrow(/startUrl/);
    expect(() => revylWeb({ app: APP, viewport: { width: 100, height: 100 } })).toThrow(/viewport/);
    expect(() => revylWeb({ app: APP }).validateApp!({ bundleId: 'com.example', url: 'https://example.com' }, { targetName: 'web' })).toThrow(/device app/);
    expect(() => revylWeb({ app: APP }).validateApp!({}, { targetName: 'web' })).toThrow(/needs app.url/);
  });

  it('starts one session on the app origin and stops it at dispose', async () => {
    const engine = await started();
    expect(calls.find((call) => call.path.endsWith('/builds/external'))?.body).toEqual({ url: 'https://example.com' });
    expect(calls.find((call) => call.path === '/api/v1/execution/start_device')?.body).toMatchObject({
      platform: 'web',
      app_id: APP,
      build_id: 'build-1',
      web: { viewport: { width: 1280, height: 800 } },
    });
    await engine.dispose!({ signal: new AbortController().signal, timeoutMs: 1_000 });
    expect(calls.filter((call) => call.path.endsWith('/stop'))).toHaveLength(1);
  });

  it('reports a session that ends before it is ready, and stops it', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method ?? 'GET', path, body });
      const answer = path.endsWith('/builds/external')
        ? { id: 'build-1' }
        : path.endsWith('/start_device')
          ? { session_id: (body as { session_id: string }).session_id, workflow_run_id: RUN }
          : { status: 'failed', error_message: 'the site returned 404' };
      return new Response(JSON.stringify(answer));
    });
    expect(await failedStart(/ended before it was ready: the site returned 404/)).toBe(1);
  });

  it('observes the page with roles from CSS queries, placeholders, and wrappers left out', async () => {
    queries[roleCss('button')] = [save];
    queries[roleCss('textbox')] = [input];
    queries[FIELD] = [input];
    const engine = await started();
    const snapshot = await engine.observe!(context());
    expect(snapshot.location).toBe('https://example.com/todos');
    const children = snapshot.root.children ?? [];
    expect(children.map((child) => [child.role, child.name, child.text, child.value, child.attributes?.['placeholder'], child.states?.hidden])).toEqual([
      ['textbox', undefined, undefined, undefined, 'What needs to be done?', false],
      ['button', 'Save', undefined, undefined, undefined, false],
      [undefined, undefined, 'Delete', undefined, undefined, true],
    ]);
  });

  it('locates by role and taps the live centre of the node', async () => {
    queries[roleCss('button')] = [save];
    const engine = await started();
    const [button] = (await engine.locate!(role('button', 'Save'), context())) as SemanticNode[];
    expect(button?.name).toBe('Save');
    await engine.perform!(button!.ref, { kind: 'tap' }, context());
    expect(calls.at(-1)).toMatchObject({ path: `/api/v1/execution/device-proxy/${RUN}/tap`, body: { x: 140, y: 220 } });
  });

  it('does not match a field value with getByText', async () => {
    const title = node('buy milk', [100, 300, 300, 330]);
    const edit = node('buy milk', [0, 0, 0, 0], [], 'Edit');
    tree = () => node('', [0, 0, 1280, 800], [node('', [0, 0, 1280, 800], [title, edit])]);
    queries[roleCss('textbox')] = [edit];
    queries[FIELD] = [edit];
    queries[':placeholder-shown'] = [];
    const engine = await started();
    const matches = await engine.locate!({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'buy milk', exact: true } } }, context());
    expect(matches.map((match) => match.rect)).toEqual([{ x: 100, y: 300, width: 200, height: 30 }]);
  });

  it('reads a select\'s chosen label as its value', async () => {
    const select = node('Option 2', [100, 300, 600, 330], [], 'dropdown');
    tree = () => node('', [0, 0, 1280, 800], [select]);
    queries[roleCss('combobox')] = [select];
    queries[FIELD] = [select];
    const engine = await started();
    const [combobox] = await engine.locate!(role('combobox'), context());
    expect([combobox?.role, combobox?.value, combobox?.text]).toEqual(['combobox', 'Option 2', undefined]);
  });

  it('reads checked and disabled states from CSS queries', async () => {
    const on = node('on', [100, 300, 113, 313]);
    const off = node('on', [100, 330, 113, 343]);
    const send = node('Send', [100, 360, 180, 390]);
    tree = () => node('', [0, 0, 1280, 800], [on, off, send]);
    queries[roleCss('checkbox')] = [on, off];
    queries[roleCss('button')] = [send];
    queries[CHECKED] = [on];
    queries[DISABLED] = [send];
    const engine = await started();
    const boxes = await engine.locate!(role('checkbox'), context());
    expect(boxes.map((box) => [box.text, box.states?.checked])).toEqual([[undefined, true], [undefined, false]]);
    const [button] = await engine.locate!(role('button', 'Send'), context());
    expect(button?.states?.disabled).toBe(true);
  });

  it('reads an empty field that reports its aria-label as having no value', async () => {
    const edit = node('Edit', [100, 300, 600, 330], [], 'edit-field');
    tree = () => node('', [0, 0, 1280, 800], [edit]);
    queries[':is(input, textarea)[aria-label="Edit"]'] = [edit];
    queries[roleCss('textbox')] = [edit];
    queries[FIELD] = [edit];
    queries[':placeholder-shown'] = [];
    const engine = await started();
    const [field] = await engine.locate!(role('textbox'), context());
    expect([field?.role, field?.value]).toEqual(['textbox', undefined]);
  });

  it('drags from one node to another, and between points in screenshot pixels', async () => {
    info = { width_pixels: 2560, height_pixels: 1600, width_grid: 1280, height_grid: 800 };
    queries[roleCss('button')] = [save];
    queries[roleCss('textbox')] = [input];
    queries[FIELD] = [input];
    const engine = await started();
    const [button] = await engine.locate!(role('button'), context());
    const [field] = await engine.locate!(role('textbox'), context());
    await engine.perform!(button!.ref, { kind: 'dragTo', target: field!.ref }, context());
    expect(calls.at(-1)).toMatchObject({ path: `/api/v1/execution/device-proxy/${RUN}/drag`, body: { start_x: 280, start_y: 440, end_x: 600, end_y: 240 } });
    await engine.performAt!({ x: 10, y: 20 }, { kind: 'dragTo', target: { x: 30, y: 40 } }, context());
    expect(calls.at(-1)?.body).toEqual({ start_x: 20, start_y: 40, end_x: 60, end_y: 80 });
  });

  it('scrolls the page from its centre in screenshot pixels', async () => {
    info = { width_pixels: 2560, height_pixels: 1600, width_grid: 1280, height_grid: 800 };
    const engine = await started();
    await engine.perform!({ id: 'root', revision: '' }, { kind: 'swipe', direction: 'down' }, context());
    expect(calls.at(-1)).toMatchObject({ path: `/api/v1/execution/device-proxy/${RUN}/scroll`, body: { x: 1280, y: 800, dx: 0, dy: 640 } });
  });

  it('switches and closes tabs by their Revyl id, and has no reset', async () => {
    tabs = [
      { tab_id: 'first', active: false, url_origin: 'https://example.com', route_pattern: '/' },
      { tab_id: 'second', active: true, url_origin: 'https://example.com', route_pattern: '/b' },
    ];
    const engine = await started();
    const session = engine.session!;
    await session.switchTab!(0, context());
    expect(calls.at(-1)).toMatchObject({ path: `/api/v1/execution/device-proxy/${RUN}/tab_switch`, body: { tab_id: 'first' } });
    await session.closeTab!(1, context());
    expect(calls.at(-1)).toMatchObject({ path: `/api/v1/execution/device-proxy/${RUN}/tab_close`, body: { tab_id: 'second' } });
    await expect(session.switchTab!(2, context())).rejects.toMatchObject({ code: 'ACTION_FAILED' });
    tabs = tabs.slice(0, 1);
    await expect(session.closeTab!(0, context())).rejects.toMatchObject({ code: 'ACTION_FAILED' });
    expect(session.reset).toBeUndefined();
  });

  it('reads again after a gateway error, and gives up after three tries', async () => {
    const engine = await started();
    failingReads = 2;
    const snapshot = await engine.observe!(context());
    expect(snapshot.root.children?.length).toBeGreaterThan(0);
    failingReads = 3;
    await expect(engine.observe!(context())).rejects.toThrow(/answered 503/);
  });

  it('starts each attempt on the first tab, closing the others', async () => {
    const engine = await started();
    tabs = [
      { tab_id: 'first', active: false, url_origin: 'https://example.com', route_pattern: '/' },
      { tab_id: 'second', active: true, url_origin: 'https://example.com', route_pattern: '/b' },
    ];
    const closing = calls.length;
    const before = tabs;
    vi.stubGlobal('fetch', wrapClose(globalThis.fetch as typeof fetch, () => (tabs = before.slice(0, 1))));
    await engine.startAttempt!({ attemptId: 'a', artifactsDir: '/tmp/a', signal: new AbortController().signal, environment: () => undefined } as never);
    expect(calls.length).toBeGreaterThan(closing);
    expect(calls.slice(-3).map((call) => [call.path.split('/').at(-1), call.body])).toEqual([
      ['tab_switch', { tab_id: 'first' }],
      ['tab_close', { tab_id: 'second' }],
      ['tabs', undefined],
    ]);
  });

  it('sends an action again only when the proxy refused it before forwarding', async () => {
    const engine = await started();
    let refusals = 1;
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (new URL(url).pathname.endsWith('/tap') && refusals > 0) {
        refusals -= 1;
        calls.push({ method: 'POST', path: new URL(url).pathname, body: undefined });
        return new Response(JSON.stringify({ detail: 'Web worker lookup is unavailable' }), { status: 503 });
      }
      return inner(url, init);
    });
    await engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, context());
    expect(calls.filter((call) => call.path.endsWith('/tap'))).toHaveLength(2);
    actionResult = { status: 502, body: 'bad gateway' };
    await expect(engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, context())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    expect(calls.filter((call) => call.path.endsWith('/tap'))).toHaveLength(3);
  });

  it('refuses a drag while a second tab is open', async () => {
    tabs = [
      { tab_id: 'first', active: false, url_origin: 'https://example.com', route_pattern: '/' },
      { tab_id: 'second', active: true, url_origin: 'https://example.com', route_pattern: '/b' },
    ];
    const engine = await started();
    await expect(engine.performAt!({ x: 10, y: 20 }, { kind: 'dragTo', target: { x: 30, y: 40 } }, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(calls.some((call) => call.path.endsWith('/drag'))).toBe(false);
  });

  it('matches an exact test id on the configured attribute only', async () => {
    const label = node('Username', [100, 280, 200, 300], [], 'username');
    const field = node('', [100, 300, 600, 330], [], 'username');
    tree = () => node('', [0, 0, 1280, 800], [label, field]);
    queries['[name="username"]'] = [field];
    const engine = await started({ testIdAttribute: 'name' });
    const exact = await engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'username', exact: true } } }, context());
    expect(exact.map((match) => match.rect?.y)).toEqual([300]);
    const pattern = await engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'regexp', source: '^user', flags: '' } } }, context());
    expect(pattern.map((match) => match.rect?.y)).toEqual([280, 300]);
  });

  it('refuses a key or an option before it sends anything', async () => {
    queries[roleCss('button')] = [save];
    const engine = await started();
    const [button] = await engine.locate!(role('button'), context());
    const sent = calls.length;
    await expect(engine.perform!(button!.ref, { kind: 'press', key: 'F5' }, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(engine.perform!(button!.ref, { kind: 'selectOption', value: { value: 'blue' } }, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(calls.slice(sent)).toEqual([]);
  });

  it('selects an option given as { label }', async () => {
    queries[roleCss('button')] = [save];
    const engine = await started();
    const [button] = await engine.locate!(role('button'), context());
    await engine.perform!(button!.ref, { kind: 'selectOption', value: { label: 'Blue' } }, context());
    expect(calls.at(-1)).toMatchObject({ path: `/api/v1/execution/device-proxy/${RUN}/select`, body: { option_label: 'Blue' } });
  });

  it('reports a checkbox state through any locator', async () => {
    const box = node('on', [100, 300, 113, 313], [], 'terms');
    tree = () => node('', [0, 0, 1280, 800], [box]);
    queries[roleCss('checkbox')] = [box];
    queries[CHECKED] = [box];
    queries['[data-testid="terms"]'] = [box];
    const engine = await started();
    const [terms] = await engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'terms', exact: true } } }, context());
    expect([terms?.role, terms?.text, terms?.states?.checked]).toEqual(['checkbox', undefined, true]);
  });

  it('never reports a password field\'s value, in the field or in a name around it', async () => {
    const password = node('hunter2', [100, 300, 600, 330], [], 'password');
    const cell = node('', [0, 290, 700, 340], [node('Password', [0, 300, 90, 330]), password]);
    tree = () => node('', [0, 0, 1280, 800], [cell]);
    queries[roleCss('textbox')] = [password];
    queries[FIELD] = [password];
    queries[roleCss('cell')] = [cell];
    queries['input[type="password"]'] = [password];
    queries[':placeholder-shown'] = [];
    const engine = await started();
    const snapshot = await engine.observe!(context());
    expect(JSON.stringify(snapshot.root)).not.toContain('hunter2');
    const [field] = await engine.locate!(role('textbox'), context());
    expect([field?.value, field?.states?.secure, field?.inputPurpose]).toEqual([undefined, true, 'password']);
    const [around] = await engine.locate!(role('cell'), context());
    expect(around?.name).toBe('Password');
  });

  it('keeps the marks after an element that moved between the reads', async () => {
    const pulse = node('Resend in 29s', [100, 100, 200, 140]);
    tree = () => node('', [0, 0, 1280, 800], [node('Resend in 28s', [100, 100, 200, 140]), save]);
    queries[roleCss('button')] = [pulse, save];
    const engine = await started();
    const buttons = await engine.locate!(role('button', 'Save'), context());
    expect(buttons.map((button) => button.name)).toEqual(['Save']);
  });

  it('cuts text to the observation limits in observe only', async () => {
    const long = 'x'.repeat(600);
    tree = () => node('', [0, 0, 1280, 800], [node(long, [100, 100, 900, 140])]);
    const engine = await started();
    const snapshot = await engine.observe!(context());
    expect(snapshot.root.children?.[0]?.text?.length).toBe(512);
    const [located] = await engine.locate!({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: long, exact: true } } }, context());
    expect(located?.text?.length).toBe(600);
  });

  it('times a read out as OPERATION_TIMEOUT, and an action cut in flight as ACTION_MAY_HAVE_COMMITTED', async () => {
    const engine = await started();
    const short = (): OperationContext => ({ ...context(), timeoutMs: 1_000 });
    delays = { maestro_web_hierarchy: 1_500 };
    await expect(engine.observe!(short())).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    delays = { tap: 1_500 };
    await expect(engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, short())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  });

  it('bounds a whole perform by one deadline', async () => {
    queries[roleCss('button')] = [save];
    const engine = await started();
    const [button] = await engine.locate!(role('button'), context());
    delays = { maestro_web_hierarchy: 600, tap: 600 };
    const begun = Date.now();
    await expect(engine.perform!(button!.ref, { kind: 'tap' }, { ...context(), timeoutMs: 1_000 })).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    expect(Date.now() - begun).toBeLessThan(1_400);
  });

  it('refuses a tap on a node whose surroundings changed at the same place', async () => {
    const row = (message: string): MaestroNode => node('', [0, 100, 1280, 140], [node(message, [0, 100, 600, 140]), node('Delete', [1000, 100, 1100, 140])]);
    tree = () => node('', [0, 0, 1280, 800], [row('first message')]);
    queries[roleCss('button')] = [node('Delete', [1000, 100, 1100, 140])];
    const engine = await started();
    const [remove] = await engine.locate!(role('button', 'Delete'), context());
    tree = () => node('', [0, 0, 1280, 800], [row('new message'), node('', [0, 140, 1280, 180], [node('first message', [0, 140, 600, 180])])]);
    await expect(engine.perform!(remove!.ref, { kind: 'tap' }, context())).rejects.toMatchObject({ code: 'NODE_STALE' });
  });

  it('scrolls an off-screen node from its own box held inside the viewport', async () => {
    const far = node('Far', [1100, 2000, 1200, 2040]);
    tree = () => node('', [0, 0, 1280, 800], [far]);
    queries[roleCss('button')] = [far];
    const engine = await started();
    const [button] = await engine.locate!(role('button'), context());
    await expect(engine.perform!(button!.ref, { kind: 'tap' }, context())).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(calls.at(-1)).toMatchObject({ path: `/api/v1/execution/device-proxy/${RUN}/scroll`, body: { x: 1150, y: 720, dx: 0, dy: 1620 } });
  });

  it('starts each attempt at the configured viewport after a test resized it', async () => {
    const engine = await started();
    info = { width_pixels: 375, height_pixels: 667, width_grid: 375, height_grid: 667 };
    await engine.session!.resize!({ width: 375, height: 667 }, context());
    info = { width_pixels: 1280, height_pixels: 800, width_grid: 1280, height_grid: 800 };
    await engine.startAttempt!({ attemptId: 'b', artifactsDir: '/tmp/b', signal: new AbortController().signal, environment: () => undefined } as never);
    expect(calls.filter((call) => call.path.endsWith('/viewport')).map((call) => call.body)).toEqual([
      { width: 375, height: 667 },
      { width: 1280, height: 800 },
    ]);
  });

  it('stops the session when the start request itself fails', async () => {
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === '/api/v1/execution/start_device') {
        calls.push({ method: 'POST', path: '/api/v1/execution/start_device', body: JSON.parse(init.body as string) });
        return new Response('upstream timeout', { status: 504 });
      }
      return inner(url, init);
    });
    expect(await failedStart(/504/)).toBe(1);
  });

  it('stops at dispose a session whose start was cut off', async () => {
    const inner = globalThis.fetch;
    const aborted = new AbortController();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (new URL(url).pathname.startsWith('/api/v1/execution/device-sessions/')) {
        aborted.abort(new Error('launch timed out'));
        throw aborted.signal.reason;
      }
      return inner(url, init);
    });
    const engine = revylWeb({ app: APP });
    await expect(engine.init!(initInfo(aborted.signal))).rejects.toThrow(/launch timed out/);
    const request = calls.find((call) => call.path === '/api/v1/execution/start_device')?.body as { session_id: string };
    const stops = (): number => calls.filter((call) => call.path === `/api/v1/execution/device/sessions/${request.session_id}/stop`).length;
    const before = stops();
    await engine.dispose!({ signal: new AbortController().signal, timeoutMs: 1_000 });
    expect(stops()).toBe(before + 1);
  });

  it('refuses app.permissions, which it cannot grant', () => {
    expect(() => revylWeb({ app: APP }).validateApp!({ url: 'https://example.com', permissions: { geolocation: 'granted' } } as never, { targetName: 'web' })).toThrow(/permissions/);
  });

  it('lets an explicit role win over the element\'s implicit one', () => {
    expect(roleCss('spinbutton')).toBe('input[type="number"]:not([role]), [role="spinbutton"]');
    expect(roleCss('textbox')).toContain('textarea:not([role])');
    expect(roleCss('combobox')).toContain('[role="combobox"]');
  });

  it('asks a structural query once per hierarchy, and state queries every read', async () => {
    queries[roleCss('button')] = [save];
    const engine = await started();
    const asked = (css: string): number => calls.filter((call) => call.path.endsWith('/maestro_web_query') && (call.body as { css: string }).css === css).length;
    // The first read after start is asked early and used once; the second
    // keeps its answer, and the third reuses it.
    await engine.locate!(role('button'), context());
    await engine.locate!(role('button'), context());
    await engine.locate!(role('button'), context());
    expect([asked(roleCss('button')), asked(DISABLED)]).toEqual([2, 3]);
    await engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, context());
    await engine.locate!(role('button'), context());
    expect(asked(roleCss('button'))).toBe(3);
    tree = () => node('', [0, 0, 1280, 800], [save]);
    await engine.locate!(role('button'), context());
    expect(asked(roleCss('button'))).toBe(4);
  });

  it('taps a node whose sibling text changes, like a countdown', async () => {
    const form = (seconds: number): MaestroNode => node('', [0, 0, 1280, 200], [node('Verify', [100, 100, 200, 140]), node(`Resend code in ${seconds}s`, [300, 100, 500, 140])]);
    tree = () => form(29);
    queries[roleCss('button')] = [node('Verify', [100, 100, 200, 140])];
    const engine = await started();
    const [verify] = await engine.locate!(role('button', 'Verify'), context());
    tree = () => form(28);
    await engine.perform!(verify!.ref, { kind: 'tap' }, context());
    expect(calls.at(-1)).toMatchObject({ path: `/api/v1/execution/device-proxy/${RUN}/tap`, body: { x: 150, y: 120 } });
  });

  it('asks a test\'s own CSS again on every read', async () => {
    queries['button:enabled'] = [];
    const engine = await started();
    expect(await engine.locate!({ kind: 'selector', selector: 'button:enabled' }, context())).toEqual([]);
    queries['button:enabled'] = [save];
    expect(await engine.locate!({ kind: 'selector', selector: 'button:enabled' }, context())).toHaveLength(1);
  });

  it('reads ARIA checked and disabled states', () => {
    expect(CHECKED).toBe(':checked, [aria-checked="true"]');
    expect(DISABLED).toBe(':disabled, [aria-disabled="true"]');
  });

  it('reads an empty field showing its aria-label as empty, but not a field whose value is another field\'s label', async () => {
    const search = node('Search', [100, 100, 600, 130], [], 'q');
    const notes = node('Search', [100, 200, 600, 230], [], 'notes');
    tree = () => node('', [0, 0, 1280, 800], [search, notes]);
    queries[roleCss('textbox')] = [search, notes];
    queries[FIELD] = [search, notes];
    queries[':placeholder-shown'] = [];
    queries[':is(input, textarea)[aria-label="Search"]'] = [search];
    const engine = await started();
    const fields = await engine.locate!(role('textbox'), context());
    expect(fields.map((field) => field.value)).toEqual([undefined, 'Search']);
  });

  it('leaves text with no size out of a name', async () => {
    const link = node('', [0, 0, 200, 40], [node('Dashboard', [0, 0, 0, 0]), node('Dash', [0, 0, 60, 40])]);
    tree = () => node('', [0, 0, 1280, 800], [link]);
    queries[roleCss('link')] = [link];
    const engine = await started();
    const [found] = await engine.locate!(role('link'), context());
    expect(found?.name).toBe('Dash');
  });

  it('presses a key without a tap on a focused field, and refuses one on a button', async () => {
    queries[roleCss('button')] = [save];
    queries[roleCss('textbox')] = [input];
    queries[FIELD] = [input];
    queries[':focus'] = [input];
    queries[markSelector({ kind: 'textEntry' })] = [input];
    const engine = await started();
    const [field] = await engine.locate!(role('textbox'), context());
    await engine.perform!(field!.ref, { kind: 'press', key: 'Enter' }, context());
    expect(calls.filter((call) => call.path.includes('/device-proxy/') && !call.path.includes('maestro_web')).map((call) => call.path.split('/').at(-1))).not.toContain('tap');
    expect(calls.at(-1)?.path.endsWith('/key')).toBe(true);
    const [button] = await engine.locate!(role('button'), context());
    const sent = calls.length;
    await expect(engine.perform!(button!.ref, { kind: 'press', key: 'Enter' }, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(calls.slice(sent).some((call) => call.path.endsWith('/tap') || call.path.endsWith('/key'))).toBe(false);
  });

  it('takes no screenshot while a filled password field is on screen', async () => {
    const password = node('hunter2', [100, 300, 600, 330], [], 'password');
    tree = () => node('', [0, 0, 1280, 800], [password]);
    queries['input[type="password"]'] = [password];
    queries[roleCss('textbox')] = [password];
    queries[FIELD] = [password];
    queries[':placeholder-shown'] = [];
    const engine = await started();
    await engine.startAttempt!({ attemptId: 'a', artifactsDir: '/tmp/revyl-web-test', signal: new AbortController().signal, environment: () => undefined } as never);
    await expect(engine.artifacts!.screenshot!('after', context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(calls.some((call) => call.path.endsWith('/screenshot'))).toBe(false);
  });

  it('acts on the part of a tall node on screen, without scrolling', async () => {
    const list = node('Item', [0, 400, 1280, 2400]);
    tree = () => node('', [0, 0, 1280, 800], [list]);
    queries[roleCss('list')] = [list];
    const engine = await started();
    const [found] = await engine.locate!(role('list'), context());
    await engine.perform!(found!.ref, { kind: 'swipe', direction: 'up' }, context());
    expect(calls.filter((call) => call.path.endsWith('/scroll')).map((call) => call.body)).toEqual([{ x: 640, y: 600, dx: 0, dy: -1600 }]);
  });

  it('gives up on an off-screen node that a scroll did not move', async () => {
    const far = node('Far', [100, 2000, 200, 2040]);
    tree = () => node('', [0, 0, 1280, 800], [far]);
    queries[roleCss('button')] = [far];
    const engine = await started();
    const [button] = await engine.locate!(role('button'), context());
    await expect(engine.perform!(button!.ref, { kind: 'tap' }, context())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await expect(engine.perform!(button!.ref, { kind: 'tap' }, context())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('sends an action again after a 429, which the proxy never forwarded', async () => {
    const engine = await started();
    let limited = 1;
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (new URL(url).pathname.endsWith('/tap') && limited > 0) {
        limited -= 1;
        calls.push({ method: 'POST', path: new URL(url).pathname, body: undefined });
        return new Response(JSON.stringify({ detail: 'Too many requests' }), { status: 429 });
      }
      return inner(url, init);
    });
    await engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, context());
    expect(calls.filter((call) => call.path.endsWith('/tap'))).toHaveLength(2);
  });

  it('sends the stop again after a gateway error at dispose', async () => {
    const engine = await started();
    let failures = 1;
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (new URL(url).pathname.endsWith('/stop')) {
        calls.push({ method: 'POST', path: new URL(url).pathname, body: undefined });
        if (failures-- > 0) return new Response('<html>bad gateway</html>', { status: 502 });
        return new Response(JSON.stringify({ success: true }));
      }
      return inner(url, init);
    });
    await engine.dispose!({ signal: new AbortController().signal, timeoutMs: 5_000 });
    expect(calls.filter((call) => call.path.endsWith('/stop'))).toHaveLength(2);
  });

  it('treats a 409 at dispose as a session Revyl already ended', async () => {
    const engine = await started();
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) =>
      new URL(url).pathname.endsWith('/stop') ? new Response(JSON.stringify({ detail: 'Web session is not active' }), { status: 409 }) : inner(url, init),
    );
    await expect(engine.dispose!({ signal: new AbortController().signal, timeoutMs: 1_000 })).resolves.toBeUndefined();
  });

  it('uses an answer asked before the hierarchy for that read only', async () => {
    const engine = await started();
    await engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, context());
    tree = () => node('', [0, 0, 1280, 800], [save]);
    queries[roleCss('button')] = [];
    await engine.locate!(role('button'), context());
    queries[roleCss('button')] = [save];
    expect(await engine.locate!(role('button'), context())).toHaveLength(1);
  });

  it('asks the password, field, and placeholder marks only after the hierarchy', async () => {
    const engine = await started();
    await engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, context());
    let answered = false;
    const askedEarly: string[] = [];
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/maestro_web_query') && !answered) askedEarly.push((JSON.parse(init.body as string) as { css: string }).css);
      const response = await inner(url, init);
      if (path.endsWith('/maestro_web_hierarchy')) answered = true;
      return response;
    });
    await engine.observe!(context());
    for (const css of ['input[type="password"]', ':placeholder-shown', FIELD]) expect(askedEarly).not.toContain(css);
    expect(askedEarly).toContain(roleCss('button'));
  });

  it('refuses a tap on a row whose content was swapped in place', async () => {
    const row = (message: string): MaestroNode => node('', [0, 100, 1280, 140], [node(message, [0, 100, 600, 140]), node('Dismiss', [1000, 100, 1100, 140])]);
    tree = () => node('', [0, 0, 1280, 800], [row('Invoice A overdue')]);
    queries[roleCss('button')] = [node('Dismiss', [1000, 100, 1100, 140])];
    const engine = await started();
    const [dismiss] = await engine.locate!(role('button', 'Dismiss'), context());
    tree = () => node('', [0, 0, 1280, 800], [row('Payment B received')]);
    await expect(engine.perform!(dismiss!.ref, { kind: 'tap' }, context())).rejects.toMatchObject({ code: 'NODE_STALE' });
  });

  it('scrolls toward an off-screen node again once an action has run', async () => {
    const far = node('Far', [100, 2000, 200, 2040]);
    tree = () => node('', [0, 0, 1280, 800], [far]);
    queries[roleCss('button')] = [far];
    const engine = await started();
    const [button] = await engine.locate!(role('button'), context());
    await expect(engine.perform!(button!.ref, { kind: 'tap' }, context())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, context());
    await expect(engine.perform!(button!.ref, { kind: 'tap' }, context())).rejects.toMatchObject({ code: 'NODE_STALE' });
    expect(calls.filter((call) => call.path.endsWith('/scroll'))).toHaveLength(2);
  });

  it('reads again after a 429', async () => {
    const engine = await started();
    let limited = 1;
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (new URL(url).pathname.endsWith('/maestro_web_hierarchy') && limited-- > 0) return new Response(JSON.stringify({ detail: 'Too many requests' }), { status: 429 });
      return inner(url, init);
    });
    await expect(engine.observe!(context())).resolves.toBeDefined();
  });

  it('names a button through a display: contents wrapper', async () => {
    const button = node('', [100, 100, 200, 140], [node('', [0, 0, 0, 0], [node('Save', [110, 110, 190, 130])])]);
    tree = () => node('', [0, 0, 1280, 800], [button]);
    queries[roleCss('button')] = [button];
    const engine = await started();
    expect((await engine.locate!(role('button', 'Save'), context())).map((found) => found.name)).toEqual(['Save']);
  });

  it('takes no screenshot while a password field Revyl reports as empty shows no placeholder', async () => {
    const password = node('', [100, 300, 600, 330], [], 'password');
    tree = () => node('', [0, 0, 1280, 800], [password]);
    queries['input[type="password"]'] = [password];
    queries[FIELD] = [password];
    queries[':placeholder-shown'] = [];
    const engine = await started();
    await engine.startAttempt!({ attemptId: 'a', artifactsDir: mkdtempSync(join(tmpdir(), 'revyl-web-')), signal: new AbortController().signal, environment: () => undefined } as never);
    await expect(engine.artifacts!.screenshot!('after', context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('takes a screenshot while a password field shows its placeholder', async () => {
    const password = node('Password', [100, 300, 600, 330], [], 'password');
    tree = () => node('', [0, 0, 1280, 800], [password]);
    queries['input[type="password"]'] = [password];
    queries[roleCss('textbox')] = [password];
    queries[FIELD] = [password];
    queries[':placeholder-shown'] = [password];
    const engine = await started();
    await engine.startAttempt!({ attemptId: 'a', artifactsDir: mkdtempSync(join(tmpdir(), 'revyl-web-')), signal: new AbortController().signal, environment: () => undefined } as never);
    await expect(engine.artifacts!.screenshot!('empty', context())).resolves.toMatch(/screenshots\/revyl-1-empty\.png$/);
  });

  it('keeps a password field secure when its answer moved between the reads', async () => {
    const password = node('hunter2', [100, 300, 600, 330], [], 'password');
    tree = () => node('', [0, 0, 1280, 800], [password]);
    queries[FIELD] = [password];
    queries['input[type="password"]'] = [node('hunter2', [100, 301, 600, 331], [], 'password')];
    queries[':placeholder-shown'] = [];
    const engine = await started();
    const snapshot = await engine.observe!(context());
    expect(JSON.stringify(snapshot.root)).not.toContain('hunter2');
    await engine.startAttempt!({ attemptId: 'a', artifactsDir: mkdtempSync(join(tmpdir(), 'revyl-web-')), signal: new AbortController().signal, environment: () => undefined } as never);
    await expect(engine.artifacts!.screenshot!('after', context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('takes no screenshot while a password field Revyl reports as empty has an answer that moved between the reads', async () => {
    const password = node('', [100, 300, 600, 330], [], 'password');
    tree = () => node('', [0, 0, 1280, 800], [password]);
    queries[FIELD] = [password];
    queries['input[type="password"]'] = [node('', [100, 301, 600, 331], [], 'password')];
    queries[':placeholder-shown'] = [];
    const engine = await started();
    await engine.startAttempt!({ attemptId: 'a', artifactsDir: mkdtempSync(join(tmpdir(), 'revyl-web-')), signal: new AbortController().signal, environment: () => undefined } as never);
    await expect(engine.artifacts!.screenshot!('after', context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(calls.some((call) => call.path.endsWith('/screenshot'))).toBe(false);
  });

  it('names a refused test id, but not a refused query the engine built, which can carry page text', async () => {
    const note = node('my secret note', [100, 300, 600, 330]);
    tree = () => node('', [0, 0, 1280, 800], [note]);
    queries[FIELD] = [note];
    queries[':placeholder-shown'] = [];
    const refused = new Set([markSelector({ kind: 'labelShown', label: 'my secret note' }), markSelector({ kind: 'testId', value: 'save', attribute: 'data-testid' }), roleCss('heading')]);
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) =>
      String(url).endsWith('/maestro_web_query') && refused.has((JSON.parse(String(init.body)) as { css: string }).css) ? new Response('{"detail":"bad selector"}', { status: 400 }) : inner(url, init),
    );
    const engine = await started();
    const error = await engine.observe!(context()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(String((error as Error).message)).not.toContain('my secret note');
    expect((error as Error).cause).toBeUndefined();
    await expect(engine.locate!({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'save', exact: true } } }, context())).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('"save"'),
    });
    await expect(engine.locate!(role('heading'), context())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
  });

  it('never sends a password value to Revyl as a selector', async () => {
    const password = node('hunter2', [100, 300, 600, 330], [], 'password');
    tree = () => node('', [0, 0, 1280, 800], [password]);
    queries[FIELD] = [password];
    queries[roleCss('textbox')] = [password];
    queries['input[type="password"]'] = [password];
    queries[':placeholder-shown'] = [];
    const engine = await started();
    await engine.observe!(context());
    await engine.locate!(role('textbox'), context());
    expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('hunter2');
  });

  it('keeps Revyl\'s words and the cause out of a sensitive fill\'s error', async () => {
    queries[roleCss('textbox')] = [input];
    queries[FIELD] = [input];
    const engine = await started();
    const [field] = await engine.locate!(role('textbox'), context());
    actionResult = { status: 422, body: { detail: [{ loc: ['body', 'text'], input: 'hunter2' }] } };
    const error = await engine.perform!(field!.ref, { kind: 'fill', value: 'hunter2', sensitive: true }, context()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(String((error as Error).message)).not.toContain('hunter2');
    expect((error as Error).cause).toBeUndefined();
  });

  it('keeps an operation within a budget under one second', async () => {
    const engine = await started();
    delays = { maestro_web_hierarchy: 600 };
    const begun = Date.now();
    await expect(engine.observe!({ ...context(), timeoutMs: 100 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(Date.now() - begun).toBeLessThan(500);
  });

  it('treats an action answered with an empty body as one that may have run', async () => {
    const engine = await started();
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => (new URL(url).pathname.endsWith('/tap') ? new Response('', { status: 200 }) : inner(url, init)));
    await expect(engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, context())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  });

  it('polls the starting session again after a gateway error', async () => {
    let failures = 1;
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) =>
      new URL(url).pathname.startsWith('/api/v1/execution/device-sessions/') && failures-- > 0 ? new Response('<html>bad gateway</html>', { status: 502 }) : inner(url, init),
    );
    await expect(started()).resolves.toBeDefined();
  });

  it('maps input types to roles as the web engine reads them', () => {
    expect(roleCss('spinbutton')).toContain('input[type="number"]');
    expect(roleCss('searchbox')).toContain('input[type="search"]:not([list])');
    expect(roleCss('button')).toContain('input[type="file"]:not([role])');
    expect(roleCss('button')).toContain('input[type="image"]:not([role])');
    expect(roleCss('combobox')).toContain('input[list]');
    expect(roleCss('listbox')).toContain('select[multiple]:not([role])');
    expect(roleCss('textbox')).not.toContain('[type="number"]:not([role])');
  });

  it('resolves a CSS selector through the page', async () => {
    queries['#save'] = [save];
    const engine = await started();
    const matches = await engine.locate!({ kind: 'selector', selector: '#save' }, context());
    expect(matches.map((match) => match.rect)).toEqual([{ x: 100, y: 200, width: 80, height: 40 }]);
  });

  it('refuses to act on a node that changed since it was located', async () => {
    queries[roleCss('button')] = [save];
    const engine = await started();
    const [button] = await engine.locate!(role('button'), context());
    tree = () => node('', [0, 0, 1280, 800], [node('', [0, 0, 1280, 800], [input, node('', [100, 260, 180, 300])])]);
    const error = await engine.perform!(button!.ref, { kind: 'tap' }, context()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it.each([
    [{ status: 502, body: 'bad gateway' }, 'ACTION_MAY_HAVE_COMMITTED'],
    [{ status: 200, body: { success: false, action: 'tap', input_dispatched: true } }, 'ACTION_MAY_HAVE_COMMITTED'],
    [{ status: 200, body: { success: false, action: 'tap', error: 'target_not_found' } }, 'NOT_ACTIONABLE'],
    [{ status: 409, body: { detail: 'Web session is not active' } }, 'ENGINE_FAILURE'],
    [{ status: 409, body: { detail: 'Web worker ownership changed' } }, 'ENGINE_FAILURE'],
    [{ status: 401, body: { detail: 'Invalid API key' } }, 'ENGINE_FAILURE'],
    [{ status: 422, body: { detail: 'Invalid Web action request' } }, 'NOT_ACTIONABLE'],
  ])('maps a %j action answer to %s', async (answer, code) => {
    const engine = await started();
    actionResult = answer;
    await expect(engine.performAt!({ x: 10, y: 10 }, { kind: 'tap' }, context())).rejects.toMatchObject({ code });
  });

  it('presses keys Revyl can send and refuses the rest', async () => {
    queries['[placeholder="What needs to be done?"]'] = [input];
    queries[markSelector({ kind: 'textEntry' })] = [input];
    const engine = await started();
    const [field] = await engine.locate!({ kind: 'query', query: { kind: 'placeholder', value: { kind: 'string', value: 'What needs to be done?', exact: true } } }, context());
    await engine.perform!(field!.ref, { kind: 'press', key: 'ControlOrMeta+a' }, context());
    expect(calls.slice(-2).map((call) => [call.path.split('/').at(-1), call.body])).toEqual([
      ['tap', { x: 300, y: 120, skip_settle: true }],
      ['key', { key: 'a', modifiers: ['ctrl'] }],
    ]);
    await expect(engine.perform!(field!.ref, { kind: 'press', key: 'x' }, context())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });
});
