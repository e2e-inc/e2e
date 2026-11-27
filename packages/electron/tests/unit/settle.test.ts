import type { OperationContext } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
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
