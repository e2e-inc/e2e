/**
 * `agent.waitFor` and `agent.extract` on the agent: one more session per
 * test attempt, with no tools, started by the attempt's first question and
 * closed when the attempt ends. Apart from the step session, so a judgment
 * never reads what a step did and can never act. The runner sends the
 * evidence in each question and validates the reply.
 */

import { randomUUID } from 'node:crypto';
import { AgentError, type ExecutorAnswer, type ExecutorQuestion } from 'e2e';
import { redactProviderKeys } from 'e2e/agent';
import { ConfigurationError } from 'e2e/engine';
import { holdSession, type HeldSession } from './held.ts';
import type { AgentLaunch } from './session.ts';
import { encodeImage, message, turnUsage, untilAborted } from './turns.ts';

const RULES = `This conversation answers questions about the screens of a real application under an end-to-end test, one question per message.
Each message stands alone: answer from the evidence in that message only, never from an earlier one.
You have no tools and need none. Reply with exactly the JSON value the message asks for and nothing else.`;

/**
 * How much one session is sent before the next question starts a fresh
 * agent. Every question carries a whole screen and none reads an earlier
 * one, so a long `waitFor` would otherwise fill the agent's context with
 * screens nothing looks at again.
 */
const SESSION_BYTES = 400_000;
/** What an attempt's memory keeps for its judgments. */
interface Judging {
  /** The session; one that is closed (a turn it could not finish, its size) is replaced by the next question. */
  held: HeldSession | undefined;
  /** What `held` was sent so far. */
  sent: number;
  /** Whether a question's turn is in flight. */
  asking: boolean;
  /** A session takes one prompt at a time, so each question waits for the one before it. */
  last: Promise<unknown>;
}

/** `StepExecutor.answer` for one executor: `registerLogin` runs wherever the agent may have written a login. */
export function createAnswer(launch: () => Promise<AgentLaunch>, registerLogin: () => void): (question: ExecutorQuestion) => Promise<ExecutorAnswer> {
  const memoryKey = `@e2e-dev/acp.judgment.${randomUUID()}`;
  return (question) => {
    const judging = judgingOf(question.attempt.memory, memoryKey);
    const answer = judging.last.then(() => {
      // A question that ran out of time while it waited leaves the session to the next one.
      question.signal.throwIfAborted();
      return ask(judging, hold(judging, question, launch, registerLogin), question, registerLogin);
    });
    judging.last = answer.catch(() => undefined);
    return answer;
  };
}

function judgingOf(memory: Map<string, unknown>, key: string): Judging {
  const existing = memory.get(key) as Judging | undefined;
  if (existing !== undefined) return existing;
  const judging: Judging = { held: undefined, sent: 0, asking: false, last: Promise.resolve() };
  memory.set(key, judging);
  return judging;
}

/** The attempt's judgment session, started on its first question and again after one that closed it. */
function hold(judging: Judging, question: ExecutorQuestion, launch: () => Promise<AgentLaunch>, registerLogin: () => void): HeldSession {
  if (judging.held !== undefined && !judging.held.closed) return judging.held;
  const held = holdSession({
    launch,
    registerLogin,
    tools: [],
    attempt: question.attempt,
    signal: question.signal,
    // A tool of the agent's own ends the turn, and the answer then fails on what the turn reports. One run after a turn ended has no answer to fail, so no later question gets this conversation.
    ownTool: () => (judging.asking ? held.cancel() : held.close()),
  });
  judging.held = held;
  judging.sent = 0;
  return held;
}

async function ask(judging: Judging, held: HeldSession, question: ExecutorQuestion, registerLogin: () => void): Promise<ExecutorAnswer> {
  const { signal, images } = question;
  const session = await held.started(signal);
  if (images.length > 0 && !session.acceptsImages) {
    throw new ConfigurationError('UNSUPPORTED_CAPABILITY', 'the ACP agent takes no images in a prompt, so it cannot answer from a screenshot: pass vision: false');
  }
  // The runner redacted the evidence; only a key the agent's start or its saved login made known since is left to catch.
  const text = redactProviderKeys([held.introduced ? undefined : RULES, question.system, question.prompt].filter((part) => part !== undefined).join('\n\n'));
  held.introduced = true;
  const encoded = images.map(encodeImage);
  judging.asking = true;
  try {
    // The agent renews a login between turns: registered once the turn settles, before anything it said is redacted and returned.
    const report = await untilAborted(session.prompt(text, encoded), signal).finally(registerLogin);
    if (report.ran.length > 0) {
      throw new AgentError('POLICY_DENIED', `The agent ran a tool of its own while answering (${report.ran.join(', ')}); a judgment reads only what the runner sent.`);
    }
    if (report.stopReason === 'refusal') throw new AgentError('MODEL_REFUSED', 'The ACP agent refused to answer the question');
    judging.sent += Buffer.byteLength(text) + encoded.reduce((total, image) => total + image.data.length, 0);
    if (judging.sent > SESSION_BYTES) held.close();
    return { ...turnUsage(session, report), text: redactProviderKeys(report.text) };
  } catch (error) {
    // A turn that was cut short or failed leaves the conversation in an unknown state: the next question starts a fresh agent.
    held.close();
    signal.throwIfAborted();
    if (error instanceof AgentError) throw error;
    throw new AgentError('MODEL_PROVIDER_FAILED', `The ACP agent session failed: ${message(error)}`, { cause: error });
  } finally {
    judging.asking = false;
  }
}
