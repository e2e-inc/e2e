/**
 * Native dialog routing for one attempt. Handlers are registered through the
 * `browser` fixture (`browser.onDialog`); the session owns the router, so a
 * dialog that fires before a test registers one is still accounted for
 * instead of silently dismissed.
 */

import { EngineError } from '@e2e-dev/core/engine';
import { isClassified, message, type ErrorLatch } from '../errors.ts';
import type { Dialog, DialogHandler } from '../fixture/types.ts';

interface Registration {
  readonly handler: DialogHandler;
}

export class DialogRouter {
  private registrations: Registration[] = [];

  /**
   * `latch` is the session's: a dialog failure and a route-handler failure
   * surface through one check at the next step.
   */
  constructor(private readonly latch: ErrorLatch) {}

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

  /**
   * Routes one native dialog to the newest registered handler; the attempt
   * end waits for it. `dialog` answers the browser's prompt as is; a handler
   * is given its own view of it, which records whether it decided.
   */
  dispatch(dialog: Dialog): Promise<void> {
    const work = this.route(dialog);
    this.latch.track('dialog', work);
    return work;
  }

  private async route(dialog: Dialog): Promise<void> {
    const handler = this.registrations.at(-1)?.handler;
    if (handler === undefined) {
      this.latch.latch(
        new EngineError(
          'INVALID_STATE',
          `unhandled ${dialog.type} dialog: ${dialog.message}`,
          { retryable: false },
        ),
      );
      await dialog.dismiss().catch(() => undefined);
      return;
    }
    let decided = false;
    let answered = false;
    const seen: Dialog = {
      type: dialog.type,
      message: dialog.message,
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
        await handler(seen);
        // A dialog left open blocks the page, and the failure would surface
        // later as an unrelated action timeout. The handler contract is the
        // same as a route handler's: decide, or the step fails naming you.
        if (!decided) {
          await dialog.dismiss().catch(() => undefined);
          this.latch.latch(
            new EngineError(
              'INVALID_STATE',
              `dialog handler returned without calling accept or dismiss for ${dialog.type} dialog: ${dialog.message}`,
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
