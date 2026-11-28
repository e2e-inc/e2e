/**
 * Worker-scoped model adapters. An agent's model is checked once per worker,
 * when the first test acquires that agent: adapter construction checks that a
 * model is configured without a live request. A failure is
 * reported once, to abort the run, instead of surfacing as one blocked step
 * per test. Adapters are shared across every agent that holds the same
 * model instance.
 */

import type { ModelAdapter } from '../agent/model/adapter.ts';
import { answeringExecutor, createExecutorJudge } from '../agent/model/executor-judge.ts';
import { createModelAdapter } from '../agent/model/sdk.ts';
import type { ExecutorAttempt } from '../agent/executor.ts';
import type { ResolvedAgentConfig, ResolvedModel } from '../config/agent.ts';
import { classifyError, type E2EError } from '../internal/errors.ts';

export class WorkerModels {
  private readonly adapters = new Map<unknown, ModelAdapter>();
  private readonly checked = new Set<ResolvedAgentConfig>();
  private failure: E2EError | undefined;

  constructor(private readonly onFailure: (error: E2EError) => void) {}

  /**
   * Builds an agent's adapter on its first use and rethrows a failure on
   * every later one; `name` is the agent's key, which a missing model names.
   * A custom executor with no model configured is exempt: its `act` steps
   * need none, and judgment methods run on it when it answers questions,
   * else fail on first use.
   */
  readonly preflight = (agent: ResolvedAgentConfig, name: string): void => {
    if (!this.checked.has(agent)) {
      this.checked.add(agent);
      if (agent.executor === undefined || agent.model !== undefined) {
        try {
          // Same instance, same adapter: a judge that is the model costs nothing.
          this.build(agent.model, name);
          this.build(agent.judge, name);
        } catch (cause) {
          this.failure = classifyError(cause);
          this.onFailure(this.failure);
        }
      }
    }
    if (this.failure !== undefined) throw this.failure;
  };

  /** A model the provider refused, met by a step's call: reported to the run once, and every later preflight rethrows it. */
  readonly unservedModel = (error: E2EError): void => {
    if (this.failure !== undefined) return;
    this.failure = error;
    this.onFailure(error);
  };

  /**
   * The adapter an agent's judgments call in one attempt: its judge model,
   * else its executor when that answers questions itself. With neither, the
   * failure names the agent `name`.
   */
  readonly judge = (agent: ResolvedAgentConfig, name: string, attempt: ExecutorAttempt): ModelAdapter => {
    const executor = answeringExecutor(agent);
    return executor === undefined ? this.build(agent.judge, name) : createExecutorJudge(executor, attempt);
  };

  /** Adapter for one resolved model; each distinct model is built once per worker. A missing one names the agent `name`. */
  readonly build = (model: ResolvedModel | undefined, name: string): ModelAdapter => {
    if (model === undefined) return createModelAdapter(model, name);
    const key = modelKey(model);
    let adapter = this.adapters.get(key);
    if (adapter === undefined) {
      adapter = createModelAdapter(model);
      this.adapters.set(key, adapter);
    }
    return adapter;
  };
}

/** Two agents share an adapter when they hold the same model instance. */
function modelKey(model: ResolvedModel): unknown {
  return model.model;
}
