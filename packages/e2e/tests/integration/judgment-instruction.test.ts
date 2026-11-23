/**
 * `agent.assert`, `agent.waitFor` and `agent.extract` bound their instruction
 * as `agent.act` does: a non-empty string of at most 8 KiB UTF-8 after NFC,
 * refused before the judge is asked anything.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeCalls, installFakeModel, judgment } from '../helpers/fake-model.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SCHEMA = `{ '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) } }`;

const CALLS = {
  'agent.assert': (instruction: string) => `agent.assert(${instruction})`,
  'agent.waitFor': (instruction: string) => `agent.waitFor(${instruction}, { interval: 100 })`,
  'agent.extract': (instruction: string) => `agent.extract(${instruction}, { schema: ${SCHEMA} })`,
} as const;

const INVALID: ReadonlyArray<readonly [label: string, source: string, message: (api: string) => string]> = [
  ['empty', `''`, (api) => `${api} requires a non-empty instruction`],
  ['blank', `'  \\n\\t '`, (api) => `${api} requires a non-empty instruction`],
  ['undefined', 'undefined', (api) => `${api} requires a non-empty instruction`],
  ['a number', '5', (api) => `${api} requires a non-empty instruction`],
  ['over 8 KiB', `'x'.repeat(8193)`, (api) => `${api} instruction is 8193 bytes; the maximum is 8192`],
  ['over 8 KiB of two-byte text', `'\\u00e9'.repeat(4097)`, (api) => `${api} instruction is 8194 bytes; the maximum is 8192`],
];

const CASES = Object.entries(CALLS).flatMap(([api, call]) =>
  INVALID.map(([label, source, message]) => ({
    title: `${api} refuses ${label}`,
    body: `await ${call(source)};`,
    message: message(api),
  })),
);

const SUITE = `import { test } from 'e2e';

${CASES.map(
  ({ title, body }) => `test(${JSON.stringify(title)}, async ({ app, agent }) => {
  await app.open();
  ${body}
});`,
).join('\n\n')}

test('assert hands the judge its instruction in NFC', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the cafe\\u0301 heading is visible');
});
`;

describe('judgment instructions', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const judge = installFakeModel(() => judgment(true, 'the observation supports it'), { modelId: 'judge' });
    const result = await runProject(
      { 'tests/instruction.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model: judge, judge } } },
      },
    );
    outcome = result.outcome;
    project = result.project;
  }, 120_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it.each(CASES)('$title before any model call', ({ title, message }) => {
    const result = resultByTitle(outcome, title);
    expect(result.status).toBe('failed');
    const error = result.attempts.at(-1)!.error!;
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toContain(message);
  });

  it('asks the judge only for the valid instruction, normalized', () => {
    expect(resultByTitle(outcome, 'assert hands the judge its instruction in NFC').status).toBe('passed');
    expect(fakeCalls.map((call) => call.instruction)).toStrictEqual(['the café heading is visible']);
  });
});
