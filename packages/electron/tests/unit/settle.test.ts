import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OperationContext } from '@e2e-dev/core/engine';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Budget } from '../../src/budget.ts';
import type { DialogRouter } from '../../src/dialogs.ts';
import { electron } from '../../src/engine.ts';
import { resolveOptions } from '../../src/options.ts';
import { ElectronSurface } from '../../src/surface.ts';

/** A dialog the app opens, as the engine's dialog handler hands it to the router. */
function openDialog(surface: ElectronSurface, message: string): void {
  (Reflect.get(surface, 'dialogs') as DialogRouter).dispatch({ type: 'confirm', message, answer: () => Promise.resolve() });
}

const cleanup = { timeoutMs: 1000, signal: new AbortController().signal };

describe('a dialog nothing answered after the last step', () => {
  it('fails the attempt from settleAttempt, once, as a step would', async () => {
    const surface = new ElectronSurface(resolveOptions({}));
    openDialog(surface, 'Sure?');
    await expect(surface.settleAttempt(cleanup)).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/^unhandled confirm dialog: Sure\?/) });
    await expect(surface.settleAttempt(cleanup)).resolves.toBeUndefined();
  });

  it('fails app.restart() and app.clearState() when the app being quit left it, not the next app\'s first step', async () => {
    const surface = new ElectronSurface(resolveOptions({}));
    const operation = { signal: new AbortController().signal, timeoutMs: 1000, runId: 'run', attemptId: 'attempt', origin: 'test' } as OperationContext;
    for (const call of [() => surface.restart(operation), () => surface.reset(operation)]) {
      openDialog(surface, 'old app');
      // The router records the failure once the dialog is answered.
      await (Reflect.get(surface, 'dialogs') as DialogRouter).settled();
      await expect(call()).rejects.toMatchObject({ message: expect.stringMatching(/^unhandled confirm dialog: old app/) });
      await expect(surface.settleAttempt(cleanup)).resolves.toBeUndefined();
    }
  });

  it('is reported through the engine\'s settleAttempt, which core awaits before the verdict', () => {
    expect(electron().settleAttempt).toBeTypeOf('function');
  });
});

describe('app.restart() and app.clearState() in their time', () => {
  const data = mkdtempSync(path.join(tmpdir(), 'e2e-electron-budget-'));
  afterAll(() => rmSync(data, { recursive: true, force: true }));

  /** A surface mid-attempt whose app quits in `quitMs` and launches at once, recording the budget each launch got. */
  function surfaceWith(quitMs: number): { readonly surface: ElectronSurface; readonly quit: ReturnType<typeof vi.fn>; readonly budgets: Budget[]; readonly file: string } {
    const surface = new ElectronSurface(resolveOptions({}));
    const userDataDir = mkdtempSync(path.join(data, 'attempt-'));
    const file = path.join(userDataDir, 'kept');
    writeFileSync(file, 'app data');
    Object.assign(surface, { userDataDir, attempt: {}, executable: '/bin/electron', recorder: undefined });
    const app = Reflect.get(surface, 'app') as { quit: unknown; launch: unknown };
    const quit = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, quitMs)));
    const budgets: Budget[] = [];
    app.quit = quit;
    app.launch = vi.fn((_setup: unknown, _operation: unknown, budget: Budget) => {
      budgets.push(budget);
      return Promise.resolve();
    });
    return { surface, quit, budgets, file };
  }

  const operation = (timeoutMs: number, signal = new AbortController().signal): OperationContext => ({ signal, timeoutMs, runId: 'run', attemptId: 'attempt', origin: 'test' }) as OperationContext;

  it('quits nothing and deletes no app data for a call already cancelled', async () => {
    const { surface, quit, file } = surfaceWith(0);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(surface.reset(operation(1000, cancelled.signal))).rejects.toMatchObject({ code: 'CANCELLED', message: expect.stringMatching(/^app\.clearState/) });
    await expect(surface.restart(operation(1000, cancelled.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(quit).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(true);
  });

  it('deletes no app data when the quit took the rest of clearState\'s time', async () => {
    const { surface, file } = surfaceWith(400);
    await expect(surface.reset(operation(300))).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', message: expect.stringMatching(/^app\.clearState/) });
    expect(existsSync(file)).toBe(true);
  });

  it('gives the launch after a restart\'s quit what the quit left of the time, not all of it', async () => {
    const { surface, budgets } = surfaceWith(200);
    await surface.restart(operation(1000));
    expect(budgets).toHaveLength(1);
    expect(budgets[0]!.deadline.remaining()).toBeLessThan(850);
  });
});
