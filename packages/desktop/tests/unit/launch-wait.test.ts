import { EngineError, type OperationContext } from '@e2e-dev/core/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DriverFailure } from '../../src/driver.ts';
import type { WindowsRead } from '../../src/launch-report.ts';
import { windowReadable, type LaunchedApp } from '../../src/launch-wait.ts';
import type { ProjectedScreen } from '../../src/nodes.ts';

/**
 * The launch wait on a scripted app whose reads take a set time, on a fake
 * clock: a read the budget cuts off answers `OPERATION_TIMEOUT`, as the
 * driver's call does, so the wait's last read can be placed a sliver before
 * the deadline every run.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A screen of a window that could be read. */
function screen(): ProjectedScreen {
  return {
    root: { ref: { id: 'root', revision: '' }, role: 'window' },
    bindings: new Map(),
    window: { x: 0, y: 0, width: 800, height: 600 },
    viewport: { width: 800, height: 600 },
    secureRects: [],
    truncated: false,
    cutShort: false,
    timedOut: false,
    rootUnread: false,
  };
}

/** A read that listed one window accessibility cannot read. */
const unreadable = (): WindowsRead => ({ windows: [{ id: 'w-mine', pid: 1, accessible: false }], candidates: 1, failures: [] });

/** A read that listed no window. */
const listedNone = (): WindowsRead => ({ windows: [], candidates: 0, failures: [] });

/** A read that listed one window and read it. */
const readable = (): WindowsRead => ({ windows: [{ id: 'w-mine', pid: 1 }], candidates: 1, failures: [], screen: screen() });

/** One scripted read: how long it takes, and what it answers (or throws). The last one repeats. */
interface ScriptedRead {
  readonly durationMs: number;
  readonly answer: WindowsRead | Error;
}

/** The budget and start of one read the wait made, from the wait's first read. */
interface ReadStart {
  readonly budgetMs: number;
  readonly offsetMs: number;
}

/** A launched app on scripted reads, recording the budget of each read the wait starts. */
function fakeApp(reads: readonly ScriptedRead[], { foreground = false }: { foreground?: boolean } = {}): { app: LaunchedApp; starts: ReadStart[] } {
  const starts: ReadStart[] = [];
  let firstAt: number | undefined;
  let index = 0;
  const app: LaunchedApp = {
    app: 'SpikeForm',
    foreground,
    runningBefore: [],
    async read(budgetMs: number): Promise<WindowsRead> {
      const now = Date.now();
      firstAt ??= now;
      starts.push({ budgetMs, offsetMs: now - firstAt });
      const scripted = reads[Math.min(index, reads.length - 1)]!;
      index += 1;
      // Nothing is sent once the budget is spent, as the surface's driver call refuses it.
      if (budgetMs <= 0) throw new EngineError('OPERATION_TIMEOUT', "list windows: the operation's budget ran out before it was sent", { retryable: false });
      await new Promise((resolve) => setTimeout(resolve, Math.min(scripted.durationMs, budgetMs)));
      // A read still running when its budget runs out is cut off, as the driver's call cuts it.
      if (scripted.durationMs > budgetMs) throw new EngineError('OPERATION_TIMEOUT', 'list windows timed out', { retryable: false });
      if (scripted.answer instanceof Error) throw scripted.answer;
      return scripted.answer;
    },
    readable(read: WindowsRead): ProjectedScreen | undefined {
      if (read.screen !== undefined) return read.screen;
      if (read.candidates === 0) return undefined;
      throw new EngineError('NODE_STALE', 'no window of SpikeForm could be read through accessibility, or each closed while it was read', { retryable: true });
    },
    exited: () => Promise.resolve(false),
    screenLocked: () => false,
  };
  return { app, starts };
}

/** Runs the launch wait on the fake clock: `opened` when it resolves, else the error it threw. */
async function waitFor(app: LaunchedApp, timeoutMs = 15_000): Promise<unknown> {
  const operation: OperationContext = { signal: new AbortController().signal, timeoutMs, runId: 'run', attemptId: 'attempt', origin: 'test' };
  const settled = windowReadable(operation, app).then(
    () => 'opened',
    (cause: unknown) => cause,
  );
  await vi.runAllTimersAsync();
  return settled;
}

describe('windowReadable', () => {
  it('reports an unreadable window the same way when the last read starts with a sliver of the wait left', async () => {
    // Reads of 130 ms with the 100 ms poll start the last one 110 ms before the deadline: too little for the read it starts.
    const { app, starts } = fakeApp([{ durationMs: 130, answer: unreadable() }]);
    const outcome = await waitFor(app);
    expect(outcome).toMatchObject({
      code: 'ENGINE_FAILURE',
      message: 'SpikeForm launched, but its window cannot be read through accessibility: the last read listed 1 window, 1 unreadable. The window may be off screen',
    });
    // The last read got the slowest finished read's time past the deadline, not the sliver that was left.
    expect(starts.at(-1)?.budgetMs).toBe(240);
  });

  it('still says a read ran out of time when a read is slower than every read before it', async () => {
    const { app } = fakeApp([
      { durationMs: 50, answer: unreadable() },
      { durationMs: 60_000, answer: unreadable() },
    ]);
    const outcome = await waitFor(app);
    expect(outcome).toMatchObject({
      code: 'ENGINE_FAILURE',
      message:
        'SpikeForm launched, but its window cannot be read through accessibility (a read ran out of time): the last read that finished listed 1 window, 1 unreadable. The window may be off screen',
    });
  });

  it('says no read finished when the only read of the wait is cut off', async () => {
    const { app } = fakeApp([{ durationMs: 60_000, answer: unreadable() }]);
    const outcome = await waitFor(app);
    expect(outcome).toMatchObject({
      code: 'ENGINE_FAILURE',
      message: 'SpikeForm launched, but its window cannot be read through accessibility (a read ran out of time): no read of its windows finished. The window may be off screen',
    });
  });

  it('opens when the window becomes readable in the last read the wait starts', async () => {
    const reads: ScriptedRead[] = [
      ...Array.from({ length: 43 }, () => ({ durationMs: 130, answer: unreadable() })),
      { durationMs: 130, answer: readable() },
    ];
    const { app } = fakeApp(reads);
    await expect(waitFor(app)).resolves.toBe('opened');
  });

  it('keeps an open that runs out of its own budget a timeout, and gives no read more than the operation has left', async () => {
    const { app, starts } = fakeApp([{ durationMs: 130, answer: unreadable() }]);
    const outcome = await waitFor(app, 1_500);
    expect(outcome).toMatchObject({
      code: 'OPERATION_TIMEOUT',
      message: 'SpikeForm launched, but the open ran out of time before its window could be read',
    });
    for (const start of starts) expect(start.budgetMs).toBeLessThanOrEqual(1_500 - start.offsetMs);
  });

  it('still says a background app opened no window when its reads list none', async () => {
    const { app } = fakeApp([{ durationMs: 130, answer: listedNone() }]);
    const outcome = await waitFor(app);
    expect(outcome).toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringMatching(/opened no window.*desktop\(\{ physicalInput: true \}\)/) });
  });

  it('still says a read ran out of time when the last read hangs past the slowest finished read', async () => {
    // Steady 130 ms reads give the last one a 240 ms budget; a hang there is slower than every finished read, not the wait ending.
    const reads: ScriptedRead[] = [
      ...Array.from({ length: 43 }, () => ({ durationMs: 130, answer: unreadable() })),
      { durationMs: 60_000, answer: unreadable() },
    ];
    const { app } = fakeApp(reads);
    const outcome = await waitFor(app);
    expect(outcome).toMatchObject({
      code: 'ENGINE_FAILURE',
      message:
        'SpikeForm launched, but its window cannot be read through accessibility (a read ran out of time): the last read that finished listed 1 window, 1 unreadable. The window may be off screen',
    });
  });

  it('reports the same failure when every read answers with a retryable failure', async () => {
    // Reads that throw inside the read itself finish too: their time sets the slowest read the last one is granted.
    const stale = new EngineError('NODE_STALE', 'snapshot: the window was replaced while it was read', {
      retryable: true,
      cause: new DriverFailure({ code: 'STALE_REF', message: 'the window was replaced while it was read' }),
    });
    const { app, starts } = fakeApp([{ durationMs: 130, answer: stale }]);
    const outcome = await waitFor(app);
    expect(outcome).toMatchObject({
      code: 'ENGINE_FAILURE',
      message:
        'SpikeForm launched, but its window cannot be read through accessibility: the last read failed with STALE_REF (the window was replaced while it was read). The window may be off screen',
    });
    expect(starts.at(-1)?.budgetMs).toBe(240);
  });

  it('keeps the failure a read answered with when the driver reports the read timed out', async () => {
    const answered = new EngineError('OPERATION_TIMEOUT', 'list windows: TIMEOUT from the fake', {
      retryable: false,
      cause: new DriverFailure({ code: 'TIMEOUT', message: 'TIMEOUT from the fake' }),
    });
    const { app } = fakeApp([{ durationMs: 10, answer: answered }]);
    const outcome = await waitFor(app);
    expect(outcome).toMatchObject({
      code: 'ENGINE_FAILURE',
      message:
        'SpikeForm launched, but its window cannot be read through accessibility (a read ran out of time): the last read failed with TIMEOUT (TIMEOUT from the fake). The window may be off screen',
    });
  });
});
