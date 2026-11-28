import type { ExecutorQuestion } from 'e2e';
import { registerProviderKey } from 'e2e/agent';
import { describe, expect, it } from 'vitest';
import { attemptOf, cleanups, eventually, scripted } from './scripted.ts';

/** One question in an attempt the test ends. */
function question(attempt = attemptOf(), extra: Partial<ExecutorQuestion> = {}) {
  const controller = new AbortController();
  cleanups.push(attempt.end);
  const asked: ExecutorQuestion = {
    system: 'Reply with one JSON object.',
    prompt: 'Is the cart empty?\n#n1 text "Cart (0)"',
    attempt: attempt.attempt as never,
    images: [],
    signal: controller.signal,
    ...extra,
  };
  return { asked, attempt, abort: (reason: unknown) => controller.abort(reason) };
}

describe('acp judgments', () => {
  it('answers a question in a session of its own with no tools, and reports the turn', async () => {
    const { executor, log } = scripted([[{ say: '{"met":true}' }]], { model: 'slow' });
    const { asked } = question();
    const answer = await executor.answer!(asked);
    expect(answer).toMatchObject({ text: '{"met":true}', provider: 'scripted-agent', modelId: 'slow', inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, estimatedCostUsd: 0.01 });
    const entries = log();
    expect(entries.find((entry) => 'session' in entry)?.['session']).toMatchObject({ tools: [] });
    const prompt = String(entries.find((entry) => 'prompt' in entry)?.['prompt']);
    expect(prompt).toContain('Each message stands alone');
    expect(prompt).toContain('Reply with one JSON object.');
    expect(prompt).toContain('#n1 text "Cart (0)"');
  });

  it('keeps one session for the questions of an attempt, sends its rules once, and closes with the attempt', async () => {
    const { executor, log } = scripted([[{ say: '1' }], [{ say: '2' }]]);
    const first = question();
    const second = question(first.attempt);
    // Asked at once: a session takes one prompt at a time, so the second waits for the first.
    const answers = await Promise.all([executor.answer!(first.asked), executor.answer!(second.asked)]);
    expect(answers.map((answer) => answer.text)).toEqual(['1', '2']);
    const prompts = log().filter((entry) => 'prompt' in entry).map((entry) => String(entry['prompt']));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain('Each message stands alone');
    expect(log().filter((entry) => 'session' in entry)).toHaveLength(1);
    const pid = log().find((entry) => 'pid' in entry)?.['pid'] as number;
    first.attempt.end();
    await eventually(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it('keeps judgments apart from the steps of the same attempt', async () => {
    const { executor, log } = scripted({ 'Is the cart empty?': [{ say: '{"met":true}' }] });
    const { asked } = question();
    await executor.answer!(asked);
    await executor.answer!(asked);
    // One session so far, the judgment one: no step ran, so no step session started.
    expect(log().filter((entry) => 'session' in entry)).toHaveLength(1);
  });

  it('sends the screenshot of a question to an agent that takes images, and refuses one that does not', async () => {
    const pixels = { data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png', width: 800, height: 600 };
    const seeing = scripted([[{ say: '{}' }]], { env: { ACP_IMAGES: '1' } });
    await seeing.executor.answer!(question(undefined, { images: [pixels] }).asked);
    expect(seeing.log()).toContainEqual({ images: ['image/png'] });
    const blind = scripted([[{ say: '{}' }]]);
    await expect(blind.executor.answer!(question(undefined, { images: [pixels] }).asked)).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
  });

  it('fails an answer whose agent ran a tool of its own, and starts a fresh agent for the next question', async () => {
    const { executor, log } = scripted([[{ ran: 'Read ~/.env', kind: 'read' }, { say: '{"met":true}' }]]);
    const first = question();
    await expect(executor.answer!(first.asked)).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringContaining('Read ~/.env') });
    // The fresh agent starts its script over, so its first turn runs the tool again: what matters is that it is a new session.
    await expect(executor.answer!(question(first.attempt).asked)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(log().filter((entry) => 'session' in entry)).toHaveLength(2);
  });

  it('answers a question asked behind one that failed on a fresh agent', async () => {
    const { executor, log } = scripted({ 'first question': [{ fail: 'overloaded' }], 'second question': [{ say: '2' }] });
    const first = question(undefined, { prompt: 'first question' });
    const second = question(first.attempt, { prompt: 'second question' });
    const [failed, answered] = await Promise.allSettled([executor.answer!(first.asked), executor.answer!(second.asked)]);
    expect(failed).toMatchObject({ status: 'rejected', reason: { code: 'MODEL_PROVIDER_FAILED' } });
    expect(answered).toMatchObject({ status: 'fulfilled', value: { text: '2' } });
    expect(log().filter((entry) => 'session' in entry)).toHaveLength(2);
  });

  it('cancels the turn of a question that ran out of time and reports the abort', async () => {
    const { executor, log } = scripted({ slow: [{ hang: true }], quick: [{ say: '1' }] });
    const { asked, abort, attempt } = question(undefined, { prompt: 'slow' });
    const answer = executor.answer!(asked);
    await eventually(() => expect(log().some((entry) => 'prompt' in entry)).toBe(true));
    const reason = new Error('deadline');
    abort(reason);
    await expect(answer).rejects.toBe(reason);
    // The agent that was cut short is gone: the next question starts a fresh one.
    const pid = log().find((entry) => 'pid' in entry)?.['pid'] as number;
    await eventually(() => expect(() => process.kill(pid, 0)).toThrow());
    expect((await executor.answer!(question(attempt, { prompt: 'quick' }).asked)).text).toBe('1');
    expect(log().filter((entry) => 'session' in entry)).toHaveLength(2);
  });

  it('leaves the session to the next question when one ran out of time waiting for its turn', async () => {
    const { executor, log } = scripted({ first: [{ say: '1' }], second: [{ say: '2' }], third: [{ say: '3' }] });
    const first = question(undefined, { prompt: 'first' });
    const second = question(first.attempt, { prompt: 'second' });
    const answers = [executor.answer!(first.asked), executor.answer!(second.asked)];
    const reason = new Error('deadline');
    second.abort(reason);
    expect(await Promise.allSettled(answers)).toMatchObject([{ status: 'fulfilled', value: { text: '1' } }, { status: 'rejected', reason }]);
    expect((await executor.answer!(question(first.attempt, { prompt: 'third' }).asked)).text).toBe('3');
    expect(log().filter((entry) => 'session' in entry)).toHaveLength(1);
    expect(log().filter((entry) => 'prompt' in entry)).toHaveLength(2);
  });

  it('starts a fresh agent once a session was sent as much as a context holds', async () => {
    const { executor, log } = scripted([[{ say: '1' }], [{ say: '2' }]]);
    const first = question(undefined, { prompt: `first ${'x'.repeat(400_000)}` });
    await executor.answer!(first.asked);
    await executor.answer!(question(first.attempt).asked);
    const prompts = log().filter((entry) => 'prompt' in entry).map((entry) => String(entry['prompt']));
    expect(log().filter((entry) => 'session' in entry)).toHaveLength(2);
    expect(prompts[1]).toContain('Each message stands alone');
  });

  it('redacts a provider key from the question and from the answer', async () => {
    const key = 'sk-judgment-9f2c1e7ab4d05386';
    registerProviderKey('judgment.test-key', key);
    const { executor, log } = scripted([[{ say: `{"seen":"${key}"}` }]]);
    const answer = await executor.answer!(question(undefined, { prompt: `Is ${key} shown?` }).asked);
    expect(answer.text).not.toContain(key);
    expect(answer.text).toContain('<secret:');
    const prompt = String(log().find((entry) => 'prompt' in entry)?.['prompt']);
    expect(prompt).not.toContain(key);
    expect(prompt).toContain('<secret:');
  });

  it('reports a refusal as the model refusing', async () => {
    const { executor } = scripted([[{ refuse: true }]]);
    await expect(executor.answer!(question().asked)).rejects.toMatchObject({ code: 'MODEL_REFUSED' });
  });

  it('reports an agent that fails the turn', async () => {
    const { executor } = scripted([[{ fail: 'overloaded' }]]);
    await expect(executor.answer!(question().asked)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED', message: expect.stringContaining('overloaded') });
  });
});
