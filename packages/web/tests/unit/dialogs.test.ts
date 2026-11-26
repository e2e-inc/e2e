/**
 * Native dialog routing: which handler answers, how registrations come and
 * go, and how a failure on the unawaited dialog path reaches the next step.
 */

import type { Dialog as PwDialog } from 'playwright-core';
import { TestError } from '@e2e-dev/core/engine';
import { describe, expect, it, vi } from 'vitest';
import { DialogRouter } from '../../src/dialogs.ts';
import { ErrorLatch } from '../../src/support.ts';

function fakeDialog(text = 'are you sure?', defaultValue = '', type: 'alert' | 'confirm' | 'prompt' | 'beforeunload' = 'confirm') {
  const accept = vi.fn(async (_text?: string) => undefined);
  const dismiss = vi.fn(async () => undefined);
  const dialog = { type: () => type, message: () => text, defaultValue: () => defaultValue, accept, dismiss } as unknown as PwDialog;
  return { dialog, accept, dismiss };
}

describe('DialogRouter', () => {
  it('routes to the newest handler and falls back once it unsubscribes', async () => {
    const router = new DialogRouter();
    const first = vi.fn();
    const second = vi.fn();
    router.add(first);
    const unsubscribe = router.add(second);

    await router.dispatch(fakeDialog().dialog);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    unsubscribe();
    await router.dispatch(fakeDialog().dialog);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('tracks registrations by identity: the same handler twice, unsubscribed once, stays', async () => {
    const router = new DialogRouter();
    const handler = vi.fn((dialog: { accept(): Promise<void> }) => dialog.accept());
    const unsubscribeFirst = router.add(handler);
    router.add(handler);
    unsubscribeFirst();
    unsubscribeFirst();

    const { dialog } = fakeDialog();
    await router.dispatch(dialog);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(() => router.throwPending()).not.toThrow();
  });

  it('applies the accept and dismiss shorthands and passes the message through', async () => {
    const router = new DialogRouter();
    router.add('accept');
    const accepted = fakeDialog();
    await router.dispatch(accepted.dialog);
    expect(accepted.accept).toHaveBeenCalledTimes(1);

    router.add('dismiss');
    const dismissed = fakeDialog();
    await router.dispatch(dismissed.dialog);
    expect(dismissed.dismiss).toHaveBeenCalledTimes(1);

    const seen: string[] = [];
    router.add((dialog) => {
      seen.push(dialog.message);
      return dialog.accept('yes');
    });
    const custom = fakeDialog('name?');
    await router.dispatch(custom.dialog);
    expect(seen).toEqual(['name?']);
    expect(custom.accept).toHaveBeenCalledWith('yes');
  });

  it('dismisses a dialog its handler left undecided and latches INVALID_STATE naming the handler', async () => {
    const router = new DialogRouter();
    router.add(() => {
      // Looked, decided nothing: the page would stay blocked behind the dialog.
    });
    const { dialog, dismiss } = fakeDialog('are you sure?');
    await router.dispatch(dialog);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(() => router.throwPending()).toThrowError(
      expect.objectContaining({
        code: 'INVALID_STATE',
        message: expect.stringContaining('returned without calling accept or dismiss'),
      }),
    );
  });

  it('dismisses an unhandled dialog and latches INVALID_STATE, thrown exactly once', async () => {
    const router = new DialogRouter();
    const { dialog, dismiss } = fakeDialog('unexpected');
    await router.dispatch(dialog);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(() => router.throwPending()).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE', message: expect.stringContaining('unexpected') }),
    );
    expect(() => router.throwPending()).not.toThrow();
  });

  it('names browser.onDialog and web({ dialogs }) in the unhandled-dialog error', async () => {
    const router = new DialogRouter();
    await router.dispatch(fakeDialog('Delete item?').dialog);
    expect(() => router.throwPending()).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(/unhandled confirm dialog: Delete item\?; register a handler with browser\.onDialog, or .*web\(\{ dialogs: 'accept' \}\)/),
      }),
    );
  });

  it('answers a dialog no handler takes with the configured policy, and latches nothing', async () => {
    const accepting = new DialogRouter(new ErrorLatch(), 'accept');
    const accepted = fakeDialog('Name?', 'keep me', 'prompt');
    await accepting.dispatch(accepted.dialog);
    // As a person clicking OK: a prompt returns its default text.
    expect(accepted.accept).toHaveBeenCalledExactlyOnceWith('keep me');
    expect(accepted.dismiss).not.toHaveBeenCalled();
    expect(() => accepting.throwPending()).not.toThrow();

    const dismissing = new DialogRouter(new ErrorLatch(), 'dismiss');
    const dismissed = fakeDialog('Leave page?');
    await dismissing.dispatch(dismissed.dialog);
    expect(dismissed.dismiss).toHaveBeenCalledTimes(1);
    expect(dismissed.accept).not.toHaveBeenCalled();
    expect(() => dismissing.throwPending()).not.toThrow();
  });

  it('writes each dialog the policy answers to the app log, and none a handler answers', async () => {
    const appLog = vi.fn();
    const router = new DialogRouter(new ErrorLatch(), 'dismiss', appLog);
    await router.dispatch(fakeDialog('Could not save', '', 'alert').dialog);
    expect(appLog).toHaveBeenCalledExactlyOnceWith({
      source: 'system',
      level: 'info',
      text: `alert dialog "Could not save" opened; dismissing it per web({ dialogs: 'dismiss' })`,
    });

    router.add('accept');
    await router.dispatch(fakeDialog().dialog);
    expect(appLog).toHaveBeenCalledTimes(1);
  });

  it('answers with the policy when the app log throws', async () => {
    const router = new DialogRouter(new ErrorLatch(), 'accept', () => {
      throw new Error('sink closed');
    });
    const { dialog, accept } = fakeDialog();
    await router.dispatch(dialog);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(() => router.throwPending()).not.toThrow();
  });

  it('latches ENGINE_FAILURE and dismisses when answering with the policy rejects', async () => {
    const router = new DialogRouter(new ErrorLatch(), 'accept');
    const { dialog, accept, dismiss } = fakeDialog();
    accept.mockRejectedValueOnce(new Error('Target closed'));
    await router.dispatch(dialog);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(() => router.throwPending()).toThrowError(
      expect.objectContaining({ code: 'ENGINE_FAILURE', message: expect.stringContaining('answering a confirm dialog failed: Target closed') }),
    );
  });

  it('lets a registered handler answer ahead of the policy, and returns to the policy once it unsubscribes', async () => {
    const router = new DialogRouter(new ErrorLatch(), 'accept');
    const unsubscribe = router.add('dismiss');
    const first = fakeDialog();
    await router.dispatch(first.dialog);
    expect(first.dismiss).toHaveBeenCalledTimes(1);
    expect(first.accept).not.toHaveBeenCalled();

    unsubscribe();
    const second = fakeDialog();
    await router.dispatch(second.dialog);
    expect(second.accept).toHaveBeenCalledTimes(1);
  });

  it('keeps an undecided function handler a failure under a policy: the handler took the dialog', async () => {
    const router = new DialogRouter(new ErrorLatch(), 'accept');
    router.add(() => undefined);
    const { dialog, accept, dismiss } = fakeDialog();
    await router.dispatch(dialog);
    expect(accept).not.toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(() => router.throwPending()).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it('latches a failing handler as ENGINE_FAILURE, thrown once', async () => {
    const router = new DialogRouter();
    router.add(() => {
      throw new Error('handler exploded');
    });
    const { dialog, dismiss } = fakeDialog();
    await router.dispatch(dialog);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(() => router.throwPending()).toThrowError(
      expect.objectContaining({ code: 'ENGINE_FAILURE', message: expect.stringContaining('handler exploded') }),
    );

    expect(() => router.throwPending()).not.toThrow();
  });

  it('dismisses a dialog when accepting rejects and leaves it unanswered', async () => {
    const router = new DialogRouter();
    const { dialog, accept, dismiss } = fakeDialog();
    accept.mockRejectedValueOnce(new Error('accept failed'));
    router.add((native) => native.accept());
    await router.dispatch(dialog);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(() => router.throwPending()).toThrowError(expect.objectContaining({ code: 'ENGINE_FAILURE' }));
  });

  it('accepts a void handler that starts an answer without awaiting it', async () => {
    const router = new DialogRouter();
    const { dialog, accept, dismiss } = fakeDialog();
    router.add((native) => { void native.accept(); });
    await router.dispatch(dialog);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
    expect(() => router.throwPending()).not.toThrow();
  });

  it('latches a classified handler failure as it was: an assertion stays ASSERTION_FAILED', async () => {
    const router = new DialogRouter();
    const failure = new TestError('ASSERTION_FAILED', 'expected the other message');
    router.add(async (dialog) => {
      await dialog.accept();
      throw failure;
    });
    await router.dispatch(fakeDialog().dialog);
    expect(() => router.throwPending()).toThrow(failure);
  });

  it('shares one latch with its owner, so either side observes the failure', async () => {
    const latch = new ErrorLatch();
    const router = new DialogRouter(latch);
    await router.dispatch(fakeDialog().dialog);
    expect(() => latch.throwPending()).toThrowError(expect.objectContaining({ code: 'INVALID_STATE' }));
    expect(() => router.throwPending()).not.toThrow();
  });
});

describe('ErrorLatch', () => {
  const budget = () => ({ timeoutMs: 1_000, signal: new AbortController().signal });

  it('keeps the first error until it is thrown, then forgets it', () => {
    const latch = new ErrorLatch();
    const first = new Error('first');
    latch.latch(first);
    latch.latch(new Error('second'));
    expect(() => latch.throwPending()).toThrow(first);
    expect(() => latch.throwPending()).not.toThrow();
  });

  it('settles with what a tracked path still running latches once it finishes', async () => {
    const latch = new ErrorLatch();
    const router = new DialogRouter(latch);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    router.add(async (dialog) => {
      await dialog.accept();
      await waiting;
      throw new TestError('ASSERTION_FAILED', 'late');
    });
    void router.dispatch(fakeDialog().dialog);
    const settling = latch.settle(budget());
    release();
    await expect(settling).rejects.toThrowError(expect.objectContaining({ code: 'ASSERTION_FAILED' }));
    await expect(latch.settle(budget())).resolves.toBeUndefined();
  });

  it('fails closed with CLEANUP_TIMEOUT naming a handler that outlives the budget, and drops what it throws later', async () => {
    const latch = new ErrorLatch();
    const router = new DialogRouter(latch);
    router.add(async (dialog) => {
      await dialog.accept();
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new TestError('ASSERTION_FAILED', 'too late to count');
    });
    const dispatched = router.dispatch(fakeDialog().dialog);
    await expect(latch.settle({ timeoutMs: 20, signal: new AbortController().signal })).rejects.toThrowError(
      expect.objectContaining({
        code: 'CLEANUP_TIMEOUT',
        category: 'infrastructure',
        message: expect.stringContaining('a dialog handler was still running'),
      }),
    );
    await dispatched;
    expect(() => latch.throwPending()).not.toThrow();
    await expect(latch.settle(budget())).resolves.toBeUndefined();
  });

  it('waits only for the paths running when it was called, so one starting during the wait is no timeout', async () => {
    const latch = new ErrorLatch();
    let startNext!: () => void;
    const first = new Promise<void>((resolve) => {
      startNext = resolve;
    });
    latch.track('route', first);
    void first.then(() => latch.track('route', new Promise<void>((resolve) => setTimeout(resolve, 50))));
    const settling = latch.settle(budget());
    startNext();
    await expect(settling).resolves.toBeUndefined();
  });

  it('reports a latched error at once, ahead of handlers still running, and names every kind still running at the timeout', async () => {
    const latch = new ErrorLatch();
    latch.latch(new TestError('ASSERTION_FAILED', 'landed in time'));
    latch.track('route', new Promise<void>(() => undefined));
    latch.track('dialog', new Promise<void>(() => undefined));
    await expect(latch.settle({ timeoutMs: 60_000, signal: new AbortController().signal })).rejects.toThrowError(
      expect.objectContaining({ code: 'ASSERTION_FAILED' }),
    );
    const bare = new ErrorLatch();
    bare.track('route', new Promise<void>(() => undefined));
    bare.track('dialog', new Promise<void>(() => undefined));
    await expect(bare.settle({ timeoutMs: 20, signal: new AbortController().signal })).rejects.toThrowError(
      expect.objectContaining({ message: expect.stringContaining('a dialog and route handler was still running') }),
    );
  });
});

describe('native dialog kind', () => {
  it.each(['alert', 'confirm', 'prompt', 'beforeunload'] as const)('exposes %s independently of identical messages', async (kind) => {
    const router = new DialogRouter();
    const native = fakeDialog('same message');
    native.dialog.type = () => kind;
    const seen: string[] = [];
    router.add(async dialog => { seen.push(dialog.type); await dialog.dismiss(); });
    await router.dispatch(native.dialog);
    expect(seen).toEqual([kind]);
    expect(native.dismiss).toHaveBeenCalledOnce();
    expect(() => router.throwPending()).not.toThrow();
  });
});
