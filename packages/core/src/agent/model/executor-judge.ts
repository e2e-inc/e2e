/**
 * The judgment tier on an executor's own model. `agent.waitFor` and
 * `agent.extract` call a `ModelAdapter`; for an agent with a custom executor
 * and no `judge` or `model`, this is that adapter over `StepExecutor.answer`.
 * An executor takes text and returns text, so the response grammar a
 * provider would enforce travels in the prompt, and the runner's own
 * validation and repair round do the enforcing.
 */

import type { ResolvedAgentConfig } from '../../config/agent.ts';
import { isE2EError } from '../../internal/errors.ts';
import { withAbort } from '../../internal/time.ts';
import type { ExecutorAnswer, ExecutorAttempt, StepExecutor } from '../executor.ts';
import { AgentError } from '../error.ts';
import { inputUpperBound, parseValidated, tokenUpperBound, type ModelAdapter, type ModelCall, type ModelProvenance, type ModelResult, type ModelUsage } from './adapter.ts';

/** An executor that answers judgment questions. */
type AnsweringExecutor = StepExecutor & Required<Pick<StepExecutor, 'answer'>>;

function answers(executor: StepExecutor | undefined): executor is AnsweringExecutor {
  return typeof executor?.answer === 'function';
}

/** The executor an agent's judgments run on: its own, when it answers questions and the agent holds no judge model. */
export function answeringExecutor(agent: Pick<ResolvedAgentConfig, 'judge' | 'executor'>): AnsweringExecutor | undefined {
  return agent.judge === undefined && answers(agent.executor) ? agent.executor : undefined;
}

/** The adapter for one attempt: its questions reach `executor.answer` with that attempt. */
export function createExecutorJudge(executor: AnsweringExecutor, attempt: ExecutorAttempt): ModelAdapter {
  // The executor names its model only once it answered; until then the report reads the executor's name.
  let answered: { provider?: string; model?: string } = {};
  return {
    get provenance(): ModelProvenance {
      return {
        provider: answered.provider ?? executor.name,
        model: answered.model ?? executor.name,
        endpoint: 'local',
        adapterVersion: `executor/${executor.version ?? '0'}`,
      };
    },
    async generate<Value>(call: ModelCall<Value>): Promise<ModelResult<Value>> {
      const prompt = call.schema === undefined ? call.prompt : `${call.prompt}\n\nResponse schema (JSON Schema):\n${JSON.stringify(call.schema)}`;
      const images = call.images ?? [];
      const inputBound = inputUpperBound(call, prompt, images);
      const deadline = AbortSignal.timeout(call.timeoutMs);
      const signal = AbortSignal.any([call.signal, deadline]);
      let answer: ExecutorAnswer;
      try {
        // Raced here too: an executor that ignores the signal must not hold the call past its deadline.
        answer = await withAbort(() => executor.answer({ system: call.system, prompt, images, attempt, signal }), signal, () => new Error('aborted'));
      } catch (cause) {
        // Only an aborted attempt is a cancellation; a question that outlived the call's budget is a timeout.
        if (call.signal.aborted) throw new AgentError('CANCELLED', 'model call cancelled', { cause });
        if (deadline.aborted) throw new AgentError('STEP_TIMEOUT', 'model call exceeded the remaining step timeout', { cause });
        // An error the executor already classified keeps its code: a configuration error is not a provider outage.
        if (isE2EError(cause)) throw cause;
        throw new AgentError('MODEL_PROVIDER_FAILED', `executor ${JSON.stringify(executor.name)} failed to answer: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
      if (typeof answer?.text !== 'string') {
        throw new AgentError('MODEL_PROVIDER_FAILED', `executor ${JSON.stringify(executor.name)} answered without text: answer() resolves with { text }`);
      }
      answered = { ...(named(answer.provider) ? { provider: answer.provider } : {}), ...(named(answer.modelId) ? { model: answer.modelId } : {}) };
      return { value: parseValidated(call, answer.text), usage: usageOf(answer, inputBound), reasoning: answer.reasoning };
    },
  };
}

/** What the executor reported of the call, where it is a usable count; the adapter's upper bound where it reported none. */
function usageOf(answer: ExecutorAnswer, inputBound: number): ModelUsage {
  const cache = {
    ...(counted(answer.cacheReadTokens) ? { cacheReadTokens: answer.cacheReadTokens } : {}),
    ...(counted(answer.cacheWriteTokens) ? { cacheWriteTokens: answer.cacheWriteTokens } : {}),
  };
  const estimatedCostUsd = counted(answer.estimatedCostUsd) ? answer.estimatedCostUsd : undefined;
  if (counted(answer.inputTokens) && counted(answer.outputTokens)) {
    return { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, ...cache, accounting: 'provider', estimatedCostUsd };
  }
  return { inputTokens: inputBound, outputTokens: tokenUpperBound(answer.text), ...cache, accounting: 'adapter-upper-bound', estimatedCostUsd };
}

function counted(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function named(value: string | undefined): value is string {
  return typeof value === 'string' && value !== '';
}
