import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OperationContext } from '@e2e-dev/core/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveOptions } from '../../src/options.ts';
import { DesktopSurface } from '../../src/surface.ts';
import { FAKE_BINARY, failure, fakeScenario, snapshotAnswer, type Scenario } from '../helpers/fake.ts';

const signal = new AbortController().signal;
const children: ChildProcess[] = [];
const fakes: { spawned: () => number[] }[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const fake of fakes.splice(0)) {
    for (const pid of fake.spawned()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already quit by the test.
      }
    }
  }
});

/** In a scripted answer, the pid of the process the fake's `launch` started for the app. */
const SPAWNED = '$spawned' as unknown as number;

/** Whether a process is gone within `ms`. */
async function gone(pid: number, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function operation(origin: 'test' | 'agent' = 'test'): OperationContext {
  return { signal, timeoutMs: 10_000, runId: 'run', attemptId: 'attempt', origin };
}

/** A real process standing in for a copy of the app the engine did not launch: the developer's own. */
function otherCopy(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']);
  children.push(child);
  return child.pid!;
}

/** A snapshot fixture's answer with its refs and window renamed, as a later snapshot of the same window reports it. */
function renamed(name: string, from: string, to: string): unknown {
  return JSON.parse(JSON.stringify(snapshotAnswer(name)).replaceAll(from, to)) as unknown;
}

interface Launch {
  readonly snapshot?: string;
  readonly openTimeoutMs?: number;
  readonly observe?: boolean;
  readonly options?: Parameters<typeof resolveOptions>[0];
}

/**
 * A surface on the scripted agent-desktop, initialized but with nothing
 * launched. The fake's `launch` starts a real process with the launch's
 * environment (its token) and reports it, as agent-desktop does; `app.pid`
 * is that process once launched.
 */
async function initialized(scenario: Scenario | ((pid: number) => Scenario), { snapshot = 'macos/appkit-form', options = {} }: Launch = {}) {
  const fake = fakeScenario({
    status: [{ ok: true, data: { version: '1.3.1', permissions: { accessibility: { state: 'granted' } } } }],
    launch: [{ spawn: true, ok: true, data: { app: 'SpikeForm', pid: SPAWNED, process_instance: 'instance-1' } }],
    'list-windows': [{ ok: true, data: [{ id: 'w-mine', title: 'Spike Form', pid: SPAWNED, process_instance: 'instance-1', is_focused: true }, { id: 'w-theirs', title: 'Spike Form', pid: 1, is_focused: false }] }],
    'list-apps': [{ ok: true, data: { apps: [{ pid: SPAWNED, process_instance: 'instance-1' }] } }],
    snapshot: [snapshotAnswer(snapshot)],
    ...(typeof scenario === 'function' ? scenario(SPAWNED) : scenario),
  });
  fakes.push(fake);
  const app = {
    get pid(): number {
      const pid = fake.spawned().at(-1);
      if (pid === undefined) throw new Error('nothing was launched');
      return pid;
    },
  };
  const surface = new DesktopSurface(resolveOptions({ binary: FAKE_BINARY, settle: false, ...options }), 'macos');
  await surface.init({
    runId: 'run',
    targetName: 'macos',
    projectRoot: process.cwd(),
    app: { bundleId: 'dev.e2e.spike.form' },
    env: fake.env,
    headed: false,
    workerSlot: 0,
    signal,
    log: () => undefined,
  });
  return { surface, fake, app };
}

/** A surface on the scripted agent-desktop, with the form launched (a real child process as the app) and observed once. */
async function launched(scenario: Scenario | ((pid: number) => Scenario), launch: Launch = {}) {
  const { openTimeoutMs = 10_000, observe = true } = launch;
  const { surface, fake, app } = await initialized(scenario, launch);
  await surface.restart({ ...operation(), timeoutMs: openTimeoutMs });
  const nodes = observe ? await surface.observe(operation(), undefined).then((observed) => [observed.root, ...(observed.root.children ?? [])]) : [];
  const byTestId = (testId: string) => {
    const node = nodes.find((candidate) => candidate.testId === testId);
    if (node === undefined) throw new Error(`no node ${testId}`);
    return node.ref;
  };
  return { surface, fake, byTestId, app };
}

/** The keys of the calls that act or read the app, without the bookkeeping around them. */
function actions(calls: readonly { key: string }[]): string[] {
  return calls.map((call) => call.key).filter((key) => !['status', 'launch', 'list-windows', 'list-apps'].includes(key));
}

const startAttempt = (surface: DesktopSurface) =>
  surface.startAttempt({
    attemptId: 'a',
    artifactsDir: process.cwd(),
    resolveSecret: async () => '',
    signal,
    appLog: () => undefined,
    navigation: () => undefined,
    environment: () => undefined,
  });

describe('DesktopSurface', () => {
  it('launches the app by id and reads only the window of the process it launched', async () => {
    const { fake } = await launched({});
    const calls = fake.calls();
    expect(calls.find((call) => call.key === 'launch')?.args).toEqual(expect.arrayContaining(['launch', 'dev.e2e.spike.form', '--activate', '--no-attach']));
    expect(calls.find((call) => call.key === 'list-windows')?.args).toEqual(['list-windows', '--app', 'SpikeForm']);
    const snapshot = calls.find((call) => call.key === 'snapshot');
    expect(snapshot?.args).toEqual(expect.arrayContaining(['--window-id', 'w-mine', '--include-bounds']));
    expect(calls.some((call) => call.args.includes('w-theirs'))).toBe(false);
    expect(new Set(calls.map((call) => call.home)).size).toBe(1);
  });

  it('reads and drives nothing before the app is opened, or once it quit', async () => {
    const { surface, fake } = await launched({}, { observe: false });
    await surface.closeApp(signal, 5_000);
    const before = fake.calls().length;
    const observed = await surface.observe(operation(), undefined);
    expect(observed.root.children).toBeUndefined();
    expect(await surface.locate({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'username', exact: true } } }, operation())).toEqual([]);
    await expect(surface.pressKey('Enter', operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fake.calls().slice(before).map((call) => call.key)).toEqual([]);
  });

  it('fills through stdin, so a secret never reaches the process arguments', async () => {
    const { surface, fake, byTestId } = await launched({});
    await surface.perform(byTestId('password'), { kind: 'fill', value: 'hunter2', sensitive: true }, operation());
    const fill = fake.calls().find((call) => call.key === 'set-value');
    expect(fill?.args).toEqual(['set-value', '@s1y1hxmo5pexrl:e2', '--timeout-ms', expect.any(String), '--stdin']);
    // agent-desktop's own wait is what is left of the operation's budget, less the margin it answers within.
    expect(Number(fill?.args[3])).toBeGreaterThan(9_000);
    expect(Number(fill?.args[3])).toBeLessThanOrEqual(9_600);
    expect(fill?.stdin).toBe('hunter2');
    expect(fake.calls().some((call) => call.args.join(' ').includes('hunter2'))).toBe(false);
  });

  it('leaves whether a box needs checking to agent-desktop, which reads its live state', async () => {
    const { surface, fake, byTestId } = await launched({});
    await surface.perform(byTestId('remember'), { kind: 'check' }, operation());
    await surface.perform(byTestId('remember'), { kind: 'uncheck' }, operation());
    expect(actions(fake.calls()).slice(-2)).toEqual(['check', 'uncheck']);
  });

  it('climbs the select ladder while each way sends nothing, and ends on the menu item', async () => {
    const { surface, fake, byTestId } = await launched({
      select: [failure('TIMEOUT', 'not_delivered')],
      expand: [failure('ACTION_NOT_SUPPORTED', 'not_delivered')],
      'snapshot:menu': [snapshotAnswer('macos/electron-menu')],
    });
    await surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation());
    expect(actions(fake.calls())).toEqual(['snapshot', 'snapshot', 'select', 'expand', 'click', 'snapshot:menu', 'click']);
    expect(fake.calls().find((call) => call.key === 'select')?.args.slice(-2)).toEqual(['--', 'Team']);
    expect(fake.calls().find((call) => call.key === 'snapshot:menu')?.args).toEqual(expect.arrayContaining(['--window-id', 'w-mine']));
    expect(fake.calls().at(-1)?.args[1]).toBe('@s3bfjcqphd2uik:e3');
  });

  it('passes a label that starts with a dash after --, so it is never read as a flag', async () => {
    const { surface, fake, byTestId } = await launched({});
    await surface.perform(byTestId('plan'), { kind: 'selectOption', value: '- None -' }, operation());
    expect(fake.calls().find((call) => call.key === 'select')?.args.slice(-2)).toEqual(['--', '- None -']);
  });

  it('stops the ladder at a way that may have landed', async () => {
    const { surface, fake, byTestId } = await launched({ select: [failure('ACTION_FAILED', 'delivered_unverified')] });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    expect(fake.calls().some((call) => call.key === 'expand')).toBe(false);
  });

  it('stops the ladder once an expand reached the app, even when the select after it sent nothing', async () => {
    const { surface, fake, byTestId } = await launched({ select: [failure('TIMEOUT', 'not_delivered')] });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    expect(actions(fake.calls())).toEqual(['snapshot', 'snapshot', 'select', 'expand', 'select']);
  });

  it('reports a stale ref in the select ladder as stale, so the list is located again', async () => {
    const { surface, fake, byTestId } = await launched({ select: [failure('STALE_REF', 'not_delivered')] });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(fake.calls().some((call) => call.key === 'expand' || call.key === 'click')).toBe(false);
  });

  it('keeps a control id across observations of a window and acts on its newest ref', async () => {
    const { surface, fake, byTestId } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), renamed('macos/appkit-form', 's1y1hxmo5pexrl', 'snewer')] });
    const signIn = byTestId('sign-in');
    const again = await surface.observe(operation(), undefined);
    expect(again.root.children?.find((node) => node.testId === 'sign-in')?.ref.id).toBe(signIn.id);
    await surface.perform(signIn, { kind: 'tap' }, operation());
    expect(fake.calls().at(-1)?.args.slice(0, 2)).toEqual(['click', '@snewer:e5']);
    await expect(surface.perform({ id: 'n9999', revision: '' }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('gives a control in another window an id of its own', async () => {
    const { surface, byTestId } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), renamed('macos/appkit-form', 'w-8032', 'w-other')] });
    const signIn = byTestId('sign-in');
    const other = await surface.observe(operation(), undefined);
    expect(other.root.children?.find((node) => node.testId === 'sign-in')?.ref.id).not.toBe(signIn.id);
  });

  it('retires an id once its control has a look-alike, so a surviving twin never inherits it', async () => {
    const button = (ref: string) => ({ role: 'button', name: 'Delete', ref_id: ref });
    const screen = (id: string, buttons: readonly unknown[]) => ({ ok: true, data: { snapshot_id: id, window: { id: 'w-1' }, tree: { role: 'window', name: 'List', children: buttons } } });
    const { surface } = await launched(
      { snapshot: [screen('s1', [button('@s1:e1')]), screen('s1', [button('@s1:e1')]), screen('s2', [button('@s2:e1'), button('@s2:e2')]), screen('s3', [button('@s3:e2')])] },
      { observe: false },
    );
    const first = await surface.observe(operation(), undefined);
    const original = first.root.children?.[0]?.ref.id;
    await surface.observe(operation(), undefined);
    const last = await surface.observe(operation(), undefined);
    expect(last.root.children?.[0]?.ref.id).not.toBe(original);
  });

  it('refuses to act on text agent-desktop gave no ref', async () => {
    const { surface } = await launched({});
    await expect(surface.perform({ id: 'root', revision: '' }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('presses keys as agent-desktop combos into the window of the launched process', async () => {
    const { surface, fake } = await launched({});
    await surface.pressKey('ControlOrMeta+a', operation());
    expect(fake.calls().at(-1)?.args).toEqual(['press', 'cmd+a', '--window-id', 'w-mine']);
  });

  it('sends no key to whatever has focus when the control it was meant for refuses focus', async () => {
    const { surface, fake, byTestId } = await launched({ focus: [failure('ACTION_NOT_SUPPORTED', 'not_delivered')] });
    await expect(surface.perform(byTestId('sign-in'), { kind: 'press', key: 'Enter' }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(fake.calls().some((call) => call.key === 'press')).toBe(false);
  });

  it('double-clicks with the real pointer, which agent-desktop requires', async () => {
    const { surface, fake, byTestId } = await launched({}, { options: { headed: true } });
    await surface.perform(byTestId('sign-in'), { kind: 'doubleTap' }, operation());
    expect(fake.calls().find((call) => call.key === 'double-click')?.args).toContain('--headed');
  });

  it('scrolls the window on a root swipe right after a restart', async () => {
    const scrollable = { ok: true, data: { snapshot_id: 's9', window: { id: 'w-mine' }, tree: { role: 'window', name: 'List', bounds: { x: 0, y: 0, width: 100, height: 100 }, children: [{ role: 'scrollarea', ref_id: '@s9:e1' }] } } };
    const { surface, fake } = await launched({ snapshot: [scrollable] }, { observe: false });
    await surface.restart(operation());
    await surface.perform({ id: 'root', revision: '' }, { kind: 'swipe', direction: 'down' }, operation());
    expect(fake.calls().at(-1)?.args.slice(0, 2)).toEqual(['scroll', '@s9:e1']);
  });

  it('reads an app with no window as an empty screen, so a locator keeps polling', async () => {
    const { surface } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), failure('WINDOW_NOT_FOUND', 'not_delivered')] });
    const matches = await surface.locate({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'username', exact: true } } }, operation());
    expect(matches).toEqual([]);
  });

  it('fails the open when the window never becomes readable, as on a locked screen', async () => {
    const hidden = { ok: false, error: { code: 'ACTION_NOT_SUPPORTED', message: 'not exposed', details: { kind: 'window_without_accessibility_element' }, disposition: { delivery: 'not_delivered', retry: 'safe' } } };
    await expect(launched({ snapshot: [hidden] }, { openTimeoutMs: 15_000 })).rejects.toThrow(/cannot be read through accessibility/);
  }, 30_000);

  it('reports an open that ran out of its own budget as a timeout, not a locked screen', async () => {
    const hidden = { ok: false, error: { code: 'ACTION_NOT_SUPPORTED', message: 'not exposed', details: { kind: 'window_without_accessibility_element' }, disposition: { delivery: 'not_delivered', retry: 'safe' } } };
    await expect(launched({ snapshot: [hidden] }, { openTimeoutMs: 1_500 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('reports a read that fails for another reason as it is, not as a locked screen', async () => {
    await expect(launched({ snapshot: [failure('PERM_DENIED', 'not_delivered')] }, { openTimeoutMs: 1_500 })).rejects.toThrow(/Accessibility/);
    await expect(launched({ snapshot: [failure('PERM_DENIED', 'not_delivered')] }, { openTimeoutMs: 1_500 })).rejects.not.toThrow(/screen may be locked/);
  });

  it('sends nothing once the operation budget is spent', async () => {
    const { surface, fake, byTestId } = await launched({});
    const before = fake.calls().length;
    await expect(surface.perform(byTestId('sign-in'), { kind: 'tap' }, { ...operation(), timeoutMs: 0 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(fake.calls()).toHaveLength(before);
  });

  it('withholds a screenshot when the snapshot did not read the whole window', async () => {
    const partial = snapshotAnswer('macos/sign-in-form') as { ok: true; data: Record<string, unknown> };
    const { surface } = await launched({ snapshot: [{ ...partial, data: { ...partial.data, complete: false } }] }, { snapshot: 'macos/sign-in-form' });
    await startAttempt(surface);
    await expect(surface.screenshot('partial', operation())).rejects.toThrow(/did not read the whole window/);
    const observed = await surface.observe(operation(), { pixels: true });
    expect(observed.pixels).toBeUndefined();
  });

  it('withholds a screenshot when a secure field moved while it was captured', async () => {
    const moved = JSON.parse(JSON.stringify(snapshotAnswer('macos/sign-in-form')).replace('"y":675', '"y":700')) as unknown;
    const form = snapshotAnswer('macos/sign-in-form');
    const { surface } = await launched({ snapshot: [form, form, form, moved] }, { snapshot: 'macos/sign-in-form' });
    await startAttempt(surface);
    await expect(surface.screenshot('moved', operation())).rejects.toThrow(/window changed while it was captured/);
  });

  it('kills nothing when the id it launched now names another process', async () => {
    const { surface, app } = await launched({ 'list-apps': [{ ok: true, data: { apps: [] } }] });
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    await surface.dispose({ signal, timeoutMs: 5_000 });
    expect(await gone(app.pid, 300)).toBe(false);
  });

  it('keeps the process as its own when a quit fails, so dispose quits it', async () => {
    const { surface, app, fake } = await launched((pid) => ({ 'list-apps': [failure('INTERNAL', 'not_delivered'), { ok: true, data: { apps: [{ pid, process_instance: 'instance-1' }] } }] }), { observe: false });
    await expect(surface.endAttempt({ signal, timeoutMs: 5_000 })).rejects.toThrow(/find SpikeForm/);
    await surface.dispose({ signal, timeoutMs: 5_000 });
    expect(fake.calls().filter((call) => call.key === 'list-apps')).toHaveLength(2);
    expect(await gone(app.pid)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('takes as its own the process a failed launch started, by its launch token, and quits it', async () => {
    const { surface, fake } = await initialized({
      launch: [{ spawn: true, ...(failure('TIMEOUT', 'delivered_unverified') as object) }],
      'list-apps': [{ spawnedApps: { name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form' } }],
    });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    const [started] = fake.spawned();
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(started).toBeDefined();
    expect(() => process.kill(started!, 0)).toThrow();
  });

  it('says which app is missing when the bundle id names none', async () => {
    const { surface } = await initialized({ launch: [failure('APP_NOT_FOUND', 'not_delivered')] });
    await expect(surface.restart(operation())).rejects.toThrow(/no installed app has the name or bundle id "dev.e2e.spike.form"/);
  });

  it('reads a window of its own process only, not one a later process with the same id owns', async () => {
    const { surface, fake } = await launched((pid) => ({ 'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }] }, { ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }] }, { ok: true, data: [{ id: 'w-replacement', pid, process_instance: 'instance-2', is_focused: true }] }] }));
    await expect(surface.pressKey('Enter', operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fake.calls().some((call) => call.args.includes('w-replacement'))).toBe(false);
  });

  it('keeps the process when the app list is incomplete, so dispose looks again', async () => {
    const { surface, fake } = await launched((pid) => ({ 'list-apps': [{ ok: true, data: { apps: [], complete: false } }, { ok: true, data: { apps: [{ pid, process_instance: 'instance-1' }] } }] }), { observe: false });
    await expect(surface.endAttempt({ signal, timeoutMs: 5_000 })).rejects.toThrow(/listed the apps only in part/);
    await surface.dispose({ signal, timeoutMs: 5_000 });
    expect(fake.calls().filter((call) => call.key === 'list-apps')).toHaveLength(2);
  });

  it('reports a type after a clear that changed the field as possibly committed', async () => {
    const { surface } = await launched({ type: [failure('STALE_REF', 'not_delivered')] });
    await expect(surface.typeText('ada', { replace: true }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
  });

  it('unchecks a mixed checkbox, whose state is neither checked nor unchecked', async () => {
    const mixed = JSON.parse(JSON.stringify(snapshotAnswer('macos/appkit-form')).replace('"value":"0"', '"value":"2","states":["indeterminate"]')) as unknown;
    const { surface, fake, byTestId } = await launched({ snapshot: [mixed] });
    await surface.perform(byTestId('remember'), { kind: 'uncheck' }, operation());
    expect(fake.calls().some((call) => call.key === 'uncheck')).toBe(true);
  });

  it('taps a point in the window where it is now, with no observation first', async () => {
    const { surface, fake } = await launched((pid) => ({ 'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true, bounds: { x: 300, y: 200, width: 400, height: 300 } }] }] }), { observe: false, options: { headed: true } });
    await surface.performAt({ x: 20, y: 30 }, { kind: 'tap' }, operation());
    expect(fake.calls().at(-1)?.args).toEqual(['mouse-click', '--xy=320,230', '--headed']);
  });

  it('gives each read of the launch wait what is left of that wait, not of the whole open', async () => {
    const { fake } = await launched({}, { openTimeoutMs: 60_000, observe: false });
    const read = fake.calls().find((call) => call.key === 'snapshot');
    expect(Number(read?.args[read.args.indexOf('--timeout-ms') + 1])).toBeLessThanOrEqual(10_000);
  });

  it('keeps every node of a screen larger than the binding cap', async () => {
    const buttons = Array.from({ length: 5_000 }, (_, index) => ({ role: 'button', name: `b${index}`, ref_id: `@s1:e${index}` }));
    const big = { ok: true, data: { snapshot_id: 's1', window: { id: 'w-mine' }, tree: { role: 'window', name: 'Big', children: buttons } } };
    const { surface, fake } = await launched({ snapshot: [big] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await surface.perform(observed.root.children![0]!.ref, { kind: 'tap' }, operation());
    expect(fake.calls().at(-1)?.args.slice(0, 2)).toEqual(['click', '@s1:e0']);
  });

  it('takes nothing as its own after a launch agent-desktop refused', async () => {
    const theirs = otherCopy();
    const { surface } = await initialized({
      launch: [failure('APP_NOT_FOUND', 'not_delivered')],
      'list-apps': [{ ok: true, data: { apps: [{ name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form', pid: theirs, process_instance: 'theirs' }] } }],
    });
    await expect(surface.restart(operation())).rejects.toThrow(/no installed app/);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    await surface.dispose({ signal, timeoutMs: 5_000 });
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('never takes a running copy without its launch token, and says the launch left nothing it could find', async () => {
    const theirs = otherCopy();
    const { surface } = await initialized({
      launch: [failure('TIMEOUT', 'delivered_unverified')],
      'list-apps': [{ ok: true, data: { apps: [{ name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form', pid: theirs, process_instance: 'theirs' }] } }],
    });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.endAttempt({ signal, timeoutMs: 1_000 })).rejects.toThrow(/no process it started was found/);
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('taps a point in the window it was taken from, even after another window took focus', async () => {
    const windows = (pid: number, first: number) => [
      { id: 'w-mine', pid, process_instance: 'instance-1', is_focused: first === 0, bounds: { x: 100, y: 100, width: 400, height: 300 } },
      { id: 'w-other', pid, process_instance: 'instance-1', is_focused: first === 1, bounds: { x: 700, y: 200, width: 400, height: 300 } },
    ];
    const { surface, fake } = await launched((pid) => ({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')], 'list-windows': [{ ok: true, data: windows(pid, 0) }, { ok: true, data: windows(pid, 0) }, { ok: true, data: windows(pid, 1) }] }), { options: { headed: true } });
    await surface.performAt({ x: 10, y: 20 }, { kind: 'tap' }, operation());
    const calls = fake.calls().map((call) => call.args);
    expect(calls.at(-2)).toEqual(['focus-window', '--window-id', 'w-mine', '--headed']);
    expect(calls.at(-1)).toEqual(['mouse-click', '--xy=110,120', '--headed']);
  });

  it('measures a point in the window a locate read, after a dialog window took over', async () => {
    const windows = (pid: number) => [
      { id: 'w-8032', pid, process_instance: 'instance-1', is_focused: false, bounds: { x: 100, y: 100, width: 400, height: 300 } },
      { id: 'w-dialog', pid, process_instance: 'instance-1', is_focused: true, bounds: { x: 500, y: 100, width: 300, height: 200 } },
    ];
    const { surface, fake } = await launched((pid) => ({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), renamed('macos/appkit-form', 'w-8032', 'w-dialog')], 'list-windows': [{ ok: true, data: windows(pid) }] }), { options: { headed: true } });
    await surface.locate({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'sign-in', exact: true } } }, operation());
    await surface.performAt({ x: 11.5, y: 16.25 }, { kind: 'tap' }, operation());
    const calls = fake.calls().map((call) => call.args);
    expect(calls.at(-2)).toEqual(['focus-window', '--window-id', 'w-dialog', '--headed']);
    expect(calls.at(-1)).toEqual(['mouse-click', '--xy=511.5,116.25', '--headed']);
  });

  it('refuses a point outside the window, which would land on another app', async () => {
    const { surface, fake } = await launched((pid) => ({ 'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true, bounds: { x: 100, y: 100, width: 100, height: 100 } }] }] }), { observe: false, options: { headed: true } });
    await expect(surface.performAt({ x: 115, y: 20 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(fake.calls().some((call) => call.key === 'mouse-click')).toBe(false);
  });

  it('goes on when select finds no such option, and reports a list that is gone as stale', async () => {
    const { surface, fake, byTestId } = await launched({ select: [failure('ELEMENT_NOT_FOUND', 'not_delivered')], expand: [failure('ELEMENT_NOT_FOUND', 'not_delivered')] });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(actions(fake.calls())).toEqual(['snapshot', 'snapshot', 'select', 'expand']);
  });

  it('scrolls the window as it is now on a root swipe, not the container of an older observation', async () => {
    const screen = (id: string) => ({ ok: true, data: { snapshot_id: id, window: { id: 'w-mine' }, tree: { role: 'window', name: 'List', bounds: { x: 0, y: 0, width: 100, height: 100 }, children: [{ role: 'scrollarea', name: id, ref_id: `@${id}:e1` }] } } });
    const { surface, fake } = await launched({ snapshot: [screen('s1'), screen('s1'), screen('s2')] });
    await surface.perform({ id: 'root', revision: '' }, { kind: 'swipe', direction: 'down' }, operation());
    expect(fake.calls().at(-1)?.args.slice(0, 2)).toEqual(['scroll', '@s2:e1']);
  });

  it.skipIf(process.platform !== 'darwin')('launches the appPath build even with a bundleId set, and refuses a bundleId that is not its own', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-bundle-'));
    const bundle = path.join(directory, 'Built.app');
    mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
    writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.e2e.built</string></dict></plist>');
    try {
      const fake = fakeScenario({ status: [{ ok: true, data: { version: '1.3.1', permissions: { accessibility: { state: 'granted' } } } }] });
      const init = (bundleId: string) =>
        new DesktopSurface(resolveOptions({ binary: FAKE_BINARY }), 'macos').init({ runId: 'r', targetName: 'mac', projectRoot: directory, app: { appPath: 'Built.app', bundleId }, env: fake.env, headed: false, workerSlot: 0, signal, log: () => undefined });
      await expect(init('dev.e2e.built')).resolves.toBeUndefined();
      await expect(init('com.example.other')).rejects.toThrow(/is not the CFBundleIdentifier "dev.e2e.built"/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the ids of one window while another window is read', async () => {
    const { surface, byTestId } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), renamed('macos/appkit-form', 'w-8032', 'w-other'), snapshotAnswer('macos/appkit-form')] });
    const signIn = byTestId('sign-in');
    await surface.observe(operation(), undefined);
    const back = await surface.observe(operation(), undefined);
    expect(back.root.children?.find((node) => node.testId === 'sign-in')?.ref.id).toBe(signIn.id);
  });

  it('keeps the launch wait within its time when each read of it is slow', async () => {
    const started = Date.now();
    await expect(launched({ 'list-windows': [{ ok: true, data: [], sleepMs: 2_000 }] }, { openTimeoutMs: 3_000, observe: false })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(4_500);
  });

  it('presses a key into a control only while it holds focus, and into its own window', async () => {
    const { surface, fake, byTestId } = await launched({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')] });
    await surface.perform(byTestId('username'), { kind: 'press', key: 'Enter' }, operation());
    expect(fake.calls().at(-1)?.args).toEqual(['press', 'return', '--window-id', 'w-mine']);
    await expect(surface.perform(byTestId('sign-in'), { kind: 'press', key: 'Enter' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(fake.calls().filter((call) => call.key === 'press')).toHaveLength(1);
  });

  it('sends no key when focusing the control fails', async () => {
    const { surface, fake, byTestId } = await launched({ focus: [failure('ACTION_NOT_SUPPORTED', 'not_delivered')] });
    await expect(surface.perform(byTestId('username'), { kind: 'press', key: 'a' }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(fake.calls().some((call) => call.key === 'press')).toBe(false);
  });

  it('reports a menu it could not close after finding no such option as possibly changed', async () => {
    const { surface, byTestId } = await launched({
      select: [failure('TIMEOUT', 'not_delivered')],
      expand: [failure('ACTION_NOT_SUPPORTED', 'not_delivered')],
      'snapshot:menu': [snapshotAnswer('macos/electron-menu')],
      press: [failure('ACTION_FAILED', 'unknown')],
    });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Enterprise' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  });

  it('never types a missing option into an editable list as free text', async () => {
    const editable = { ok: true, data: { snapshot_id: 's5', window: { id: 'w-mine' }, tree: { role: 'window', name: 'Form', children: [{ role: 'combobox', name: 'Plan', ref_id: '@s5:e1', available_actions: ['Click', 'SetValue', 'SetFocus'] }] } } };
    const { surface, fake } = await launched({ snapshot: [editable], select: [failure('ELEMENT_NOT_FOUND', 'not_delivered')], 'snapshot:menu': [snapshotAnswer('macos/electron-menu')] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await expect(surface.perform(observed.root.children![0]!.ref, { kind: 'selectOption', value: 'Enterprise' }, operation())).rejects.toThrow(/no option "Enterprise"/);
    expect(fake.calls().some((call) => call.key === 'set-value')).toBe(false);
  });

  it('reads the next window when the focused-first one is a panel accessibility cannot read', async () => {
    const hidden = { ok: false, error: { code: 'ACTION_NOT_SUPPORTED', message: 'not exposed', details: { kind: 'window_without_accessibility_element' }, disposition: { delivery: 'not_delivered', retry: 'safe' } } };
    const { surface, fake } = await launched(
      (pid) => ({
        'list-windows': [{ ok: true, data: [{ id: 'w-panel', pid, process_instance: 'instance-1', visible: true }, { id: 'w-doc', pid, process_instance: 'instance-1', visible: true }] }],
        snapshot: [hidden, snapshotAnswer('macos/appkit-form')],
      }),
      { observe: false },
    );
    const observed = await surface.observe(operation(), undefined);
    expect(observed.root.children?.length).toBeGreaterThan(0);
    expect(fake.calls().filter((call) => call.key === 'snapshot').map((call) => call.args[2])).toEqual(expect.arrayContaining(['w-panel', 'w-doc']));
  });

  it.skipIf(process.platform === 'win32')('refuses a launch that agent-desktop says handed over to a copy already running', async () => {
    const theirs = otherCopy();
    const { surface } = await initialized({ launch: [{ ok: true, data: { app: 'SpikeForm', pid: theirs, process_instance: 'theirs' } }] });
    await expect(surface.restart(operation())).rejects.toThrow(/handed over to a copy already running/);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('types keystrokes into the focused field, which only physical input sends', async () => {
    const { surface, fake } = await launched({}, { options: { headed: true } });
    await surface.typeText('ada', { replace: false }, operation());
    expect(fake.calls().find((call) => call.key === 'type')?.args).toContain('--headed');
  });

  it('fails doctor on an appPath that is no app bundle', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-empty-'));
    mkdirSync(path.join(directory, 'Empty.app'));
    try {
      const fake = fakeScenario({ status: [{ ok: true, data: { version: '1.3.1', permissions: { accessibility: { state: 'granted' }, screen_recording: { state: 'granted' } } } }] });
      const surface = new DesktopSurface(resolveOptions({ binary: FAKE_BINARY }), 'macos');
      const checks = await surface.doctor({ targetName: 'mac', projectRoot: directory, app: { appPath: 'Empty.app' }, env: fake.env, headed: false, signal, log: () => undefined });
      expect(checks.find((check) => check.id === 'app-path')).toMatchObject({ status: 'fail', message: expect.stringMatching(/no Contents\/Info.plist/) });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'darwin')('opens no app bundle once the operation budget is spent', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-bundle-'));
    mkdirSync(path.join(directory, 'Built.app', 'Contents'), { recursive: true });
    writeFileSync(path.join(directory, 'Built.app', 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.e2e.built</string></dict></plist>');
    try {
      const fake = fakeScenario({ status: [{ ok: true, data: { version: '1.3.1', permissions: { accessibility: { state: 'granted' } } } }] });
      const surface = new DesktopSurface(resolveOptions({ binary: FAKE_BINARY }), 'macos');
      await surface.init({ runId: 'r', targetName: 'mac', projectRoot: directory, app: { appPath: 'Built.app' }, env: fake.env, headed: false, workerSlot: 0, signal, log: () => undefined });
      await expect(surface.restart({ ...operation(), timeoutMs: 0 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('quits the process it launched at the end of the attempt, and only that one', async () => {
    const { surface, app, fake } = await launched({});
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(app.pid)).toBe(true);
    expect(fake.calls().some((call) => call.key === 'close-app')).toBe(false);
  });
});
