import { spawn } from 'node:child_process';
import type { OperationContext } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import { resolveOptions } from '../../src/options.ts';
import { DesktopSurface } from '../../src/surface.ts';
import { FAKE_BINARY, failure, fakeScenario, snapshotAnswer, type Scenario } from '../helpers/fake.ts';

const signal = new AbortController().signal;

function operation(origin: 'test' | 'agent' = 'test'): OperationContext {
  return { signal, timeoutMs: 10_000, runId: 'run', attemptId: 'attempt', origin };
}

/** A surface on the scripted agent-desktop, with the form launched and observed once. */
async function launched(scenario: Scenario, snapshot = 'macos/appkit-form', pid = 0, openTimeoutMs = 10_000) {
  const fake = fakeScenario({
    status: [{ ok: true, data: { version: '1.3.1', permissions: { accessibility: { state: 'granted' } } } }],
    launch: [{ ok: true, data: { app: 'SpikeForm', ...(pid === 0 ? {} : { pid, process_instance: 'instance-1' }) } }],
    'list-apps': [{ ok: true, data: { apps: pid === 0 ? [] : [{ pid, process_instance: 'instance-1' }] } }],
    snapshot: [snapshotAnswer(snapshot)],
    ...scenario,
  });
  const surface = new DesktopSurface(resolveOptions({ binary: FAKE_BINARY, settle: false }), 'macos');
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
  await surface.restart({ ...operation(), timeoutMs: openTimeoutMs });
  const observed = await surface.observe(operation(), undefined);
  const nodes = [observed.root, ...(observed.root.children ?? [])];
  const byTestId = (testId: string) => {
    const node = nodes.find((candidate) => candidate.testId === testId);
    if (node === undefined) throw new Error(`no node ${testId}`);
    return node.ref;
  };
  return { surface, fake, byTestId };
}

describe('DesktopSurface', () => {
  it('launches the app by id and scopes every later command to the name agent-desktop reported', async () => {
    const { fake } = await launched({});
    const calls = fake.calls();
    expect(calls.find((call) => call.key === 'launch')?.args).toEqual(expect.arrayContaining(['launch', 'dev.e2e.spike.form', '--activate', '--no-attach']));
    const snapshot = calls.find((call) => call.key === 'snapshot');
    expect(snapshot?.args).toEqual(expect.arrayContaining(['--app', 'SpikeForm', '--include-bounds']));
    expect(new Set(calls.map((call) => call.home)).size).toBe(1);
  });

  it('fills through stdin, so a secret never reaches the process arguments', async () => {
    const { surface, fake, byTestId } = await launched({});
    await surface.perform(byTestId('password'), { kind: 'fill', value: 'hunter2', sensitive: true }, operation());
    const fill = fake.calls().find((call) => call.key === 'set-value');
    expect(fill?.args).toEqual(['set-value', '@s1y1hxmo5pexrl:e2', '--timeout-ms', '9600', '--stdin']);
    expect(fill?.stdin).toBe('hunter2');
    expect(fake.calls().some((call) => call.args.join(' ').includes('hunter2'))).toBe(false);
  });

  it('skips a check on a box already in the wanted state', async () => {
    const { surface, fake, byTestId } = await launched({});
    await surface.perform(byTestId('remember'), { kind: 'uncheck' }, operation());
    expect(fake.calls().some((call) => call.key === 'uncheck')).toBe(false);
    await surface.perform(byTestId('remember'), { kind: 'check' }, operation());
    expect(fake.calls().filter((call) => call.key === 'check')).toHaveLength(1);
  });

  it('climbs the select ladder while each rung sends nothing, and ends on the menu item', async () => {
    const { surface, fake, byTestId } = await launched({
      select: [failure('TIMEOUT', 'not_delivered')],
      'snapshot:menu': [snapshotAnswer('macos/electron-menu')],
    });
    await surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation());
    const keys = fake.calls().map((call) => call.key).filter((key) => !['status', 'launch', 'close-app'].includes(key));
    expect(keys).toEqual(['snapshot', 'snapshot', 'select', 'expand', 'select', 'click', 'snapshot:menu', 'click']);
    expect(fake.calls().at(-1)?.args[1]).toBe('@s3bfjcqphd2uik:e3');
  });

  it('stops the ladder at a rung that may have landed', async () => {
    const { surface, fake, byTestId } = await launched({ select: [failure('ACTION_FAILED', 'delivered_unverified')] });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    expect(fake.calls().some((call) => call.key === 'expand')).toBe(false);
  });

  it('keeps a control id across observations and acts on its newest ref', async () => {
    const { surface, fake, byTestId } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/sign-in-form')] });
    const signIn = byTestId('sign-in');
    const again = await surface.observe(operation(), undefined);
    expect(again.root.children?.find((node) => node.testId === 'sign-in')?.ref.id).toBe(signIn.id);
    await surface.perform(signIn, { kind: 'tap' }, operation());
    expect(fake.calls().at(-1)?.args.slice(0, 2)).toEqual(['click', '@sbtip0r53suug:e5']);
    await expect(surface.perform({ id: 'n9999', revision: '' }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('refuses to act on text agent-desktop gave no ref', async () => {
    const { surface } = await launched({});
    await expect(surface.perform({ id: 'root', revision: '' }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('presses keys as agent-desktop combos into the app', async () => {
    const { surface, fake } = await launched({});
    await surface.pressKey('ControlOrMeta+a', operation());
    expect(fake.calls().at(-1)?.args).toEqual(['press', 'cmd+a', '--app', 'SpikeForm']);
  });

  it('reads an app with no window as an empty screen, so a locator keeps polling', async () => {
    const { surface } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), failure('APP_NOT_FOUND', 'not_delivered')] });
    const matches = await surface.locate({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'username', exact: true } } }, operation());
    expect(matches).toEqual([]);
  });

  it('kills nothing when the id it launched now names another process', async () => {
    const app = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']);
    try {
      const { surface } = await launched({ 'list-apps': [{ ok: true, data: { apps: [{ pid: app.pid, process_instance: 'instance-2' }] } }] }, 'macos/appkit-form', app.pid);
      await surface.endAttempt({ signal, timeoutMs: 5_000 });
      expect(app.exitCode).toBeNull();
      expect(app.signalCode).toBeNull();
    } finally {
      app.kill();
    }
  });

  it('fails the open when the window never becomes readable, as on a locked screen', async () => {
    const hidden = { ok: false, error: { code: 'ACTION_NOT_SUPPORTED', message: 'not exposed', details: { kind: 'window_without_accessibility_element' }, disposition: { delivery: 'not_delivered', retry: 'safe' } } };
    await expect(launched({ snapshot: [hidden] }, 'macos/appkit-form', 0, 1_500)).rejects.toThrow(/cannot be read through accessibility/);
  });

  it('sends nothing once the operation budget is spent', async () => {
    const { surface, fake, byTestId } = await launched({});
    const before = fake.calls().length;
    await expect(surface.perform(byTestId('sign-in'), { kind: 'tap' }, { ...operation(), timeoutMs: 0 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(fake.calls()).toHaveLength(before);
  });

  it('withholds a screenshot when the snapshot did not read the whole window', async () => {
    const partial = snapshotAnswer('macos/sign-in-form') as { ok: true; data: Record<string, unknown> };
    const { surface } = await launched({ snapshot: [{ ...partial, data: { ...partial.data, complete: false } }] }, 'macos/sign-in-form');
    await surface.startAttempt({
      attemptId: 'a',
      artifactsDir: process.cwd(),
      resolveSecret: async () => '',
      signal,
      appLog: () => undefined,
      navigation: () => undefined,
      environment: () => undefined,
    });
    await expect(surface.screenshot('partial', operation())).rejects.toThrow(/did not read the whole window/);
    const observed = await surface.observe(operation(), { pixels: true });
    expect(observed.pixels).toBeUndefined();
  });

  it('quits the process it launched at the end of the attempt, and only that one', async () => {
    const app = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']);
    const exited = new Promise((resolve) => app.once('exit', (_code, exitSignal) => resolve(exitSignal)));
    const { surface, fake } = await launched({}, 'macos/appkit-form', app.pid);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    await expect(exited).resolves.toBe('SIGKILL');
    expect(fake.calls().some((call) => call.key === 'close-app')).toBe(false);
  });
});
