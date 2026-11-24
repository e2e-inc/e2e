/**
 * `agent.assert`, `agent.waitFor` and `agent.extract` bound their instruction
 * as `agent.act` does: a non-empty string of at most 8 KiB UTF-8 after NFC,
 * refused before the judge is asked anything.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extracted, fakeCalls, installFakeModel, judgment } from '../helpers/fake-model.ts';
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

// One secret written decomposed, and one followed by a combining mark that NFC
// composes into its last letter: only an instruction redacted before NFC keeps both out.
const SECRET = 'synthetic-probe-cafe\u0301-777';
const TAIL = 'synthetic-probe-tail';
const REDACTED = 'look for <secret:probe> and <secret:tail>\u0301';
// A provider key the test sets after the session opened, followed by a combining mark.
const LATE_KEY = 'sk-proj-synthetic-late-key-0123456789abcdefghijklmnl';
const LATE_REDACTED = 'see <secret:OPENAI_API_KEY>\u0301';

const SECRET_CASES = Object.entries(CALLS).map(([api, call]) => ({
  title: `${api} keeps a secret out of the model input however NFC changes it`,
  body: `await ${call(`'look for synthetic-probe-cafe\\u0301-777 and synthetic-probe-tail\\u0301'`)};`,
}));

const CASES = Object.entries(CALLS).flatMap(([api, call]) =>
  INVALID.map(([label, source, message]) => ({
    title: `${api} refuses ${label}`,
    body: `await ${call(source)};`,
    message: message(api),
  })),
);

const SUITE = `import { test } from 'e2e';

${[...CASES, ...SECRET_CASES].map(
  ({ title, body }) => `test(${JSON.stringify(title)}, async ({ app, agent }) => {
  await app.open();
  ${body}
});`,
).join('\n\n')}

test('a provider key set during the test stays out of the model input', async ({ app, agent }) => {
  await app.open();
  const previousKey = process.env['OPENAI_API_KEY'];
  try {
    process.env['OPENAI_API_KEY'] = ${JSON.stringify(LATE_KEY)};
    await agent.assert('see ' + process.env['OPENAI_API_KEY'] + '\\u0301');
    await agent.waitFor('see ' + process.env['OPENAI_API_KEY'] + '\\u0301', { interval: 100 });
    await agent.extract('see ' + process.env['OPENAI_API_KEY'] + '\\u0301', { schema: ${SCHEMA} });
  } finally {
    if (previousKey === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = previousKey;
  }
});

test('assert hands the judge its instruction in NFC', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the cafe\\u0301 heading is visible');
});

test('waitFor hands the judge its condition in NFC', async ({ app, agent }) => {
  await app.open();
  await agent.waitFor('the cre\\u0300me banner is visible', { interval: 100 });
});

test('extract hands the model its instruction in NFC', async ({ app, agent }) => {
  await app.open();
  await agent.extract('the nai\\u0308ve counter', { schema: ${SCHEMA} });
});
`;

describe('judgment instructions', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    const judge = installFakeModel(
      (call) => (call.schemaName === 'agent-judgment-2' ? judgment(true, 'the observation supports it') : extracted({ counter: '0' })),
      { modelId: 'judge' },
    );
    const result = await runProject(
      { 'tests/instruction.e2e.ts': SUITE },
      {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model: judge, judge } }, secrets: { probe: SECRET, tail: TAIL } },
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

  it('asks the model only for the valid instructions, each in NFC', () => {
    for (const title of [
      'assert hands the judge its instruction in NFC',
      'waitFor hands the judge its condition in NFC',
      'extract hands the model its instruction in NFC',
    ]) {
      expect(resultByTitle(outcome, title).status).toBe('passed');
    }
    expect(fakeCalls.map((call) => call.instruction).toSorted()).toStrictEqual([
      REDACTED,
      REDACTED,
      REDACTED,
      LATE_REDACTED,
      LATE_REDACTED,
      LATE_REDACTED,
      'the café heading is visible',
      'the crème banner is visible',
      'the naïve counter',
    ]);
  });

  it('keeps a secret out of the model input and the report however NFC changes it', () => {
    for (const { title } of SECRET_CASES) {
      const result = resultByTitle(outcome, title);
      expect(result.status).toBe('passed');
      expect(result.attempts.at(-1)!.steps.map((step) => step.label)).toContain(REDACTED);
    }
    const written = [JSON.stringify(fakeCalls), readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8')];
    expect(resultByTitle(outcome, 'a provider key set during the test stays out of the model input').status).toBe('passed');
    for (const text of written) {
      expect(text).not.toContain(LATE_KEY);
      for (const value of [SECRET, SECRET.normalize('NFC'), TAIL, `${TAIL}\u0301`.normalize('NFC')]) {
        expect(text).not.toContain(value);
      }
    }
  });
});
