/**
 * Native dialog routing for one attempt. Handlers are registered by the `web`
 * fixture; the surface owns the router so a dialog that fires before a test
 * ever touches `web` is still accounted for instead of silently dismissed.
 */

import type { Dialog as PwDialog } from 'playwright-core';
import { EngineError, type AppLogEntry } from '@e2e-dev/core/engine';
import { ErrorLatch, isClassified, message } from './support.ts';

/** A native dialog as a test's handler sees it. */
export interface Dialog {
  /** The native dialog kind, independent of its message. */
  readonly type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  /** The dialog's text. */
  readonly message: string;
  /** Accepts the dialog once. */
  accept(text?: string): Promise<void>;
  /** Dismisses the dialog once. */
  dismiss(): Promise<void>;
}

export type DialogHandler = 'accept' | 'dismiss' | ((dialog: Dialog) => void | Promise<void>);

/** How `web({ dialogs })` answers a dialog no `browser.onDialog` handler takes. */
export type DialogPolicy = 'accept' | 'dismiss';

/** The values `web({ dialogs })` takes. */
export const DIALOG_POLICIES: readonly DialogPolicy[] = ['accept', 'dismiss'];

interface Registration {
  readonly handler: DialogHandler;
}

export class DialogRouter {
  private registrations: Registration[] = [];

  /**
   * `latch` is shared with the surface: a dialog failure and a route-handler
   * failure surface through one check at the next step. `policy` answers a
   * dialog no handler takes; without one, such a dialog is dismissed and
   * fails the next step. `appLog` takes a line for each dialog the policy
   * answers, so an app's `alert('Could not save')` stays in the report.
   */
  constructor(
    private readonly latch: ErrorLatch = new ErrorLatch(),
    private readonly policy?: DialogPolicy,
    private readonly appLog?: (entry: AppLogEntry) => void,
  ) {}

  /**
   * Registers a handler (the newest wins) and returns its idempotent
   * unsubscribe. Registrations are tracked by identity, so registering the
   * same handler twice and unsubscribing once leaves one in place.
   */
  add(handler: DialogHandler): () => void {
    const registration: Registration = { handler };
    this.registrations.push(registration);
    return () => {
      this.registrations = this.registrations.filter((entry) => entry !== registration);
    };
  }

  /** Rethrows an error latched by an unhandled or failing dialog handler. */
  throwPending(): void {
    this.latch.throwPending();
  }

  /** Routes one native dialog to the newest registered handler, else the policy; the attempt end waits for it. */
  dispatch(dialog: PwDialog): Promise<void> {
    const work = this.route(dialog);
    this.latch.track('dialog', work);
    return work;
  }

  /**
   * Answers with the configured policy, as a person would: an accepted
   * `prompt` returns its default text, not an empty string. The app-log line
   * is written before the answer, while the step that opened the dialog is
   * still running, so it says the answer is under way: when the answer then
   * fails, the next step fails with `ENGINE_FAILURE`.
   */
  private async answer(dialog: PwDialog, policy: DialogPolicy): Promise<void> {
    const answering = policy === 'accept' ? 'accepting' : 'dismissing';
    try {
      this.appLog?.({ source: 'system', level: 'info', text: `${dialog.type()} dialog "${dialog.message()}" opened; ${answering} it per web({ dialogs: '${policy}' })` });
    } catch {
      // The harness's sink never fails a page event.
    }
    try {
      if (policy === 'accept') await dialog.accept(dialog.defaultValue());
      else await dialog.dismiss();
    } catch (cause) {
      this.latch.latch(new EngineError('ENGINE_FAILURE', `answering a ${dialog.type()} dialog failed: ${message(cause)}`, { retryable: false, cause }));
      await dialog.dismiss().catch(() => undefined);
    }
  }

  private async route(dialog: PwDialog): Promise<void> {
    // A test's own handler comes first; the configured policy only answers
    // what no handler takes, so an explorer or an agent step, which cannot
    // register one, still gets past a confirmation.
    const handler = this.registrations.at(-1)?.handler;
    if (handler === undefined && this.policy !== undefined) {
      await this.answer(dialog, this.policy);
      return;
    }
    if (handler === undefined) {
      this.latch.latch(
        new EngineError(
          'INVALID_STATE',
          `unhandled ${dialog.type()} dialog: ${dialog.message()}; register a handler with browser.onDialog, or answer every dialog with web({ dialogs: 'accept' }) or web({ dialogs: 'dismiss' })`,
          { retryable: false },
        ),
      );
      await dialog.dismiss().catch(() => undefined);
      return;
    }
    let decided = false;
    let answered = false;
    const publicDialog: Dialog = {
      type: dialog.type() as Dialog['type'],
      message: dialog.message(),
      accept: async (text) => {
        decided = true;
        await dialog.accept(text);
        answered = true;
      },
      dismiss: async () => {
        decided = true;
        await dialog.dismiss();
        answered = true;
      },
    };
    try {
      if (handler === 'accept') await dialog.accept();
      else if (handler === 'dismiss') await dialog.dismiss();
      else {
        await handler(publicDialog);
        // A dialog left open blocks the page, and the failure would surface
        // later as an unrelated action timeout. The handler contract is the
        // same as a route handler's: decide, or the step fails naming you.
        if (!decided) {
          await dialog.dismiss().catch(() => undefined);
          this.latch.latch(
            new EngineError(
              'INVALID_STATE',
              `dialog handler returned without calling accept or dismiss for ${dialog.type()} dialog: ${dialog.message()}`,
              { retryable: false },
            ),
          );
        }
      }
    } catch (cause) {
      // A failed assertion or a policy refusal keeps its code; only an
      // unclassified throw is the engine's to name.
      this.latch.latch(
        isClassified(cause)
          ? cause
          : new EngineError('ENGINE_FAILURE', `dialog handler failed: ${message(cause)}`, {
              retryable: false,
              cause,
            }),
      );
      if (!answered) await dialog.dismiss().catch(() => undefined);
    }
  }
}
