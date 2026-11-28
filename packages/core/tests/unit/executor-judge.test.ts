import { describe, expect, it } from 'vitest';
import type { ExecutorAnswer, ExecutorAttempt, ExecutorQuestion, StepExecutor } from '../../src/agent/executor.ts';
import type { ModelCall } from '../../src/agent/model/adapter.ts';
import { answeringExecutor, createExecutorJudge } from '../../src/agent/model/executor-judge.ts';
import { ConfigurationError } from '../../src/internal/errors.ts';

const attempt = { attemptId: 'a' } as ExecutorAttempt;

function judge(answer: (question: ExecutorQuestion) => Promise<ExecutorAnswer>) {
  const executor: StepExecutor = { name: 'brain', version: '2', runStep: async () => ({ status: 'passed', summary: '' }), answer };
  return createExecutorJudge(answeringExecutor({ executor, judge: undefined })!, attempt);
}

function call(extra: Partial<ModelCall<unknown>> = {}): ModelCall<unknown> {
  return {
    system: 'policy',
    prompt: 'question',
    schemaName: 'answer',
    schema: undefined,
    validate: (value) => ({ ok: true, value }),
    maxOutputTokens: 100,
    maxInputTokens: 10_000,
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    ...extra,
  };
}

describe('the judge an executor answers for', () => {
  it('is the executor only when the agent holds no judge model', () => {
    const executor: StepExecutor = { name: 'brain', runStep: async () => ({ status: 'passed', summary: '' }), answer: async () => ({ text: '{}' }) };
    expect(answeringExecutor({ executor, judge: undefined })).toBe(executor);
    expect(answeringExecutor({ executor, judge: { provider: 'p', id: 'm', model: {} as never } })).toBeUndefined();
    expect(answeringExecutor({ executor: { name: 'mute', runStep: executor.runStep }, judge: undefined })).toBeUndefined();
  });

  it('sends the schema in the prompt and every image, and returns the validated value', async () => {
    const asked: ExecutorQuestion[] = [];
    const adapter = judge(async (question) => {
      asked.push(question);
      return { text: '```json\n{"met":true}\n```', provider: 'house', modelId: 'house-1', inputTokens: 7, outputTokens: 3 };
    });
    const image = { data: new Uint8Array(4), mediaType: 'image/png', width: 10, height: 10 };
    const result = await adapter.generate(call({ schema: { type: 'object' }, images: [image, image] }));
    expect(result.value).toEqual({ met: true });
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3, accounting: 'provider' });
    expect(asked[0]!.prompt).toContain('Response schema (JSON Schema):\n{"type":"object"}');
    expect(asked[0]!.images).toHaveLength(2);
    expect(asked[0]!.attempt).toBe(attempt);
    expect(adapter.provenance).toMatchObject({ provider: 'house', model: 'house-1', endpoint: 'local', adapterVersion: 'executor/2' });
  });

  it('keeps the code of an error the executor classified', async () => {
    const adapter = judge(async () => {
      throw new ConfigurationError('UNSUPPORTED_CAPABILITY', 'no images');
    });
    await expect(adapter.generate(call())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', category: 'configuration' });
  });

  it('reports any other failure as the provider failing, and an answer that is not the JSON asked for as invalid', async () => {
    await expect(judge(async () => Promise.reject(new Error('overloaded'))).generate(call())).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED', message: expect.stringContaining('overloaded') });
    await expect(judge(async () => ({ text: 'It is met.' })).generate(call())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID', rawText: 'It is met.' });
  });

  it('times out an executor that ignores the signal, and cancels with the attempt', async () => {
    const never = () => new Promise<ExecutorAnswer>(() => undefined);
    await expect(judge(never).generate(call({ timeoutMs: 20 }))).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
    const controller = new AbortController();
    const pending = judge(never).generate(call({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('refuses a question over the input budget before asking', async () => {
    let asked = false;
    const adapter = judge(async () => {
      asked = true;
      return { text: '{}' };
    });
    await expect(adapter.generate(call({ maxInputTokens: 5 }))).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(asked).toBe(false);
  });

  it('counts by its own upper bound when the executor reports no usable usage, and names itself when it names no model', async () => {
    const adapter = judge(async () => ({ text: '{}', inputTokens: -5, outputTokens: Number.NaN, estimatedCostUsd: -1, modelId: '' }));
    const result = await adapter.generate(call());
    expect(result.usage).toEqual({ inputTokens: 14, outputTokens: 2, accounting: 'adapter-upper-bound', estimatedCostUsd: undefined });
    expect(adapter.provenance).toMatchObject({ provider: 'brain', model: 'brain' });
  });
});
