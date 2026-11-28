/**
 * `agent.waitFor` and `agent.extract` on a custom executor that answers
 * judgment questions itself (`StepExecutor.answer`), with no model
 * configured: real Playwright observations, a scripted executor.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutorQuestion, StepExecutor } from '@e2e-dev/core/lib/agent/executor';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { extracted, judgment } from '../helpers/fake-model.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test, expect } from 'e2e';
import { z } from 'zod';

test('judges on the executor', async ({ app, agent }) => {
  await app.open();
  await agent.act('look at the screen');
  await agent.waitFor('the Late arrival button exists', { interval: 100 });
  const data = await agent.extract('the counter value', { schema: z.object({ counter: z.string() }) });
  expect(data.counter).toBe('0');
});

test('repairs an answer that is not the JSON asked for', async ({ app, agent }) => {
  await app.open();
  const data = await agent.extract('the counter value, once more', { schema: z.object({ counter: z.string() }) });
  expect(data.counter).toBe('0');
});
`;

/** The screen a question carries. */
function observed(question: ExecutorQuestion): string {
  return /<observation[\s\S]*<\/observation>/.exec(question.prompt)?.[0] ?? '';
}

describe('judgments on a custom executor', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;
  const questions: ExecutorQuestion[] = [];
  const stepAttempts: string[] = [];

  const answering: StepExecutor = {
    name: 'house-brain',
    version: '3',
    async runStep(context) {
      stepAttempts.push(context.attempt.attemptId);
      return { status: 'passed', summary: 'looked' };
    },
    async answer(question) {
      questions.push(question);
      if (question.prompt.includes('Late arrival button exists')) {
        // Judged from the evidence, not the instruction: the button arrives after the page loads.
        const met = observed(question).includes('Late arrival');
        return { text: JSON.stringify(judgment(met, met ? 'The button is listed.' : 'No such button yet.')), modelId: 'house-1', inputTokens: 7, outputTokens: 3 };
      }
      // The first answer to the second test's question is prose; the runner asks again with the rejection.
      const repairing = question.prompt.includes('once more') && questions.filter((asked) => asked.prompt.includes('once more')).length === 1;
      return { text: repairing ? 'The counter reads 0.' : `\`\`\`json\n${JSON.stringify(extracted({ counter: '0' }))}\n\`\`\``, modelId: 'house-1' };
    },
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    const result = await runProject(
      { 'tests/judgment.e2e.ts': SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { executor: answering } } } },
    );
    outcome = result.outcome;
    project = result.project;
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('passes with no model configured', () => {
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.exitCode).toBe(0);
    assertValidReport(outcome.report);
  });

  it('asks in the attempt the steps run in, with the evidence and the response grammar in the text', () => {
    const waited = questions.findLast((question) => question.prompt.includes('Late arrival button exists'))!;
    expect(observed(waited)).toContain('Late arrival');
    expect(waited.attempt.attemptId).toBe(stepAttempts[0]);
    expect(waited.system).toContain('exactly one JSON object');
    expect(waited.prompt).toContain('<observation ');
    expect(waited.prompt).toContain('Response schema (JSON Schema):');
    expect(waited.images).toEqual([]);
  });

  it('asks again with the rejection when an answer is not valid', () => {
    const again = questions.filter((question) => question.prompt.includes('once more'));
    expect(again).toHaveLength(2);
    expect(again[1]!.prompt).toContain('The counter reads 0.');
  });

  it('reports the judgment steps with the model the executor named and the usage it reported', () => {
    const steps = resultByTitle(outcome, 'judges on the executor').attempts[0]!.steps;
    const waited = steps.find((step) => step.api === 'agent.waitFor')!;
    expect(waited.status).toBe('passed');
    expect(waited.model).toMatchObject({ provider: 'house-brain', model: 'house-1', endpoint: 'local', tokenAccounting: 'provider', calls: expect.any(Number) });
    expect(steps.find((step) => step.api === 'agent.extract')?.model).toMatchObject({ provider: 'house-brain', model: 'house-1', tokenAccounting: 'adapter-upper-bound' });
  });
});
