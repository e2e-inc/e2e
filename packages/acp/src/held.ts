/** One agent session held for a test attempt, for its steps or for its judgments. */

import { AgentError, type ExecutorAttempt } from 'e2e';
import { ConfigurationError } from 'e2e/engine';
import type { ServedTool } from './mcp.ts';
import { startSession, type AcpSession, type AgentLaunch } from './session.ts';
import { message, untilAborted } from './turns.ts';

export interface HeldSession {
  /** Whether the session has had its rules, which only its first message carries. */
  introduced: boolean;
  /** Cancels the turn in flight. */
  cancel(): void;
  /** Closes the agent: the next step or question starts a fresh one. */
  close(): void;
  /** Whether the session is closed, by `close` or by the attempt's end. */
  readonly closed: boolean;
  /** The session once it is up; a start that failed or outlived `signal` closes it. */
  started(signal: AbortSignal): Promise<AcpSession>;
}

export interface HoldSpec {
  readonly launch: () => Promise<AgentLaunch>;
  readonly tools: readonly ServedTool[];
  readonly attempt: ExecutorAttempt;
  /** Of the step or question that starts the session: its end stops a startup still in progress. */
  readonly signal: AbortSignal;
  /** Called when the agent ran a tool of its own. */
  readonly ownTool: (title: string) => void;
  /** Runs once the agent has started, or failed to: signing in is when it writes a login. */
  readonly registerLogin: () => void;
}

/** Starts a session that lives until it is closed or the attempt ends. */
export function holdSession(spec: HoldSpec): HeldSession {
  const { attempt } = spec;
  let session: AcpSession | undefined;
  let closed = false;
  const starting = spec
    .launch()
    .then((how) => startSession(how, spec.tools, AbortSignal.any([attempt.signal, spec.signal]), spec.ownTool))
    .then((started) => {
      session = started;
      if (closed) started.close();
      return started;
    });
  starting.catch(() => undefined);
  const held: HeldSession = {
    introduced: false,
    cancel: () => void session?.cancel(),
    get closed() {
      return closed;
    },
    close() {
      if (closed) return;
      closed = true;
      attempt.signal.removeEventListener('abort', held.close);
      session?.close();
    },
    async started(signal) {
      try {
        return await untilAborted(starting, signal).finally(spec.registerLogin);
      } catch (error) {
        held.close();
        signal.throwIfAborted();
        if (error instanceof ConfigurationError) throw error;
        throw new AgentError('MODEL_PROVIDER_FAILED', `The ACP agent did not start: ${message(error)}`, { cause: error });
      }
    },
  };
  // Serial members share one memory, each with its own attempt: a session closed with its attempt is not the next one's.
  attempt.signal.addEventListener('abort', held.close, { once: true });
  return held;
}
