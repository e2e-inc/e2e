/**
 * The sessions one attempt drives: the test's own, when something of the
 * test uses it, and one for each actor it names (`actors.ts`). Where they
 * are alike the attempt treats them alike: it collects what each engine
 * holds from a path no step awaited, shows the screen of the one a failure
 * is about, and keeps what each learned of secrets shared while it closes
 * them one after another.
 */

import type { ResolvedConfig } from '@e2e-dev/core/lib/config/resolve';
import type { TargetSession } from '@e2e-dev/core/lib/engine/surface';
import type { EngineSessions } from '@e2e-dev/core/lib/run/engine-sessions';
import { holdSessionSecrets, sessionLedger } from '@e2e-dev/core/lib/run/secrecy';
import type { FailureScreen } from './failure-evidence.ts';

export interface DrivenSession {
  /** The actor's name, as its steps carry it; undefined for the test's own session. */
  readonly actor: string | undefined;
  readonly session: TargetSession;
  /**
   * Collects a failure the session's engine holds from a path no step
   * awaited (a route or dialog handler that threw), and rejects with it.
   */
  settle(): Promise<void>;
  /** Where the session's screen is read for the evidence of a failure. */
  screen(): FailureScreen;
}

/** The test's own `session` on the worker's engine, as one the attempt drives. */
export function ownSession(sessions: EngineSessions, session: TargetSession, config: ResolvedConfig): DrivenSession {
  const appBase = sessions.target.app.base;
  return {
    actor: undefined,
    session,
    settle: () => sessions.settleAttempt(session),
    screen: () => ({
      session, appBase, appOrigin: appBase?.origin,
      ledger: sessionLedger(session, config.allSecrets),
      operation: (signal, timeoutMs) => sessions.op(session, timeoutMs, signal),
    }),
  };
}

/**
 * Keeps the secret values each of `sessions` knows shared while the attempt
 * closes them one after another, so what each writes at its end (a text
 * download) is still rewritten for what the others learned. Returns what
 * stops the sharing: call it once every artifact has settled.
 */
export function holdSecrets(sessions: readonly DrivenSession[], config: ResolvedConfig): () => void {
  const held = sessions.map(({ session }) => holdSessionSecrets(session, config.allSecrets));
  return () => {
    for (const release of held) release();
  };
}
