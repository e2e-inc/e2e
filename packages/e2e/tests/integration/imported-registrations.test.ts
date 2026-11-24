import { describe, expect, it } from 'vitest';
import { resultByTitle, runProjectWithConfigFile, workerFakeConfigSource } from '../helpers/run-project.ts';

/** A helper module that registers a hook and a test while it evaluates, and counts its evaluations in `state.ts`. */
const HELPER = `import { test } from 'e2e';
import { state } from './state.ts';

state.helperLoads += 1;
test.beforeEach(() => { state.hookRuns += 1; });
test('from the helper', async () => {});
`;

/** A module that registers nothing: one instance for the worker, so it sees every count. */
const STATE = `export const state = { helperLoads: 0, hookRuns: 0, libraryLoads: 0 };
`;

/** A module whose function registers a test when a test file calls it; it registers nothing by itself. */
const LIBRARY = `import { test } from 'e2e';
import { state } from './state.ts';

state.libraryLoads += 1;
export function declareTest(title: string): void { test(title, async () => {}); }
`;

const SUPPORT = { 'tests/helper.ts': HELPER, 'tests/state.ts': STATE, 'tests/library.ts': LIBRARY };

describe('tests and hooks a test file gets from a module it imports', () => {
  it(
    'reach every test of a parallel file on one worker, each import of the file evaluating the module again',
    async () => {
      const { outcome, project } = await runProjectWithConfigFile(
        {
          ...SUPPORT,
          'tests/file.e2e.ts': `import { expect, test } from 'e2e';
import './helper.ts';
import { declareTest } from './library.ts';
import { state } from './state.ts';

test.describe.configure({ parallel: true });
let hookRunsBefore = -1;
test.beforeEach(() => { hookRunsBefore = state.hookRuns; });
for (const title of ['one', 'two', 'three']) {
  test(title, async () => {
    // The helper's beforeEach ran for this test: it is declared first, so it ran before this file's.
    expect(hookRunsBefore).toBeGreaterThan(0);
    expect(state.libraryLoads).toBe(1);
  });
}
declareTest('from the library');
test('counts the imports', async () => {
  expect(state.helperLoads).toBeGreaterThan(1);
});`,
        },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.title, result.status])).toEqual([
        ['from the helper', 'passed'],
        ['one', 'passed'],
        ['two', 'passed'],
        ['three', 'passed'],
        ['from the library', 'passed'],
        ['counts the imports', 'passed'],
      ]);
      expect(outcome.exitCode).toBe(0);
    },
    120_000,
  );

  it(
    'reach the second test file a worker imports, and the tests after a failed one',
    async () => {
      const file = (name: string): string => `import { expect, test } from 'e2e';
import './helper.ts';
import { state } from './state.ts';

let hookRunsBefore = -1;
test.beforeEach(() => { hookRunsBefore = state.hookRuns; });
test('${name} fails', async () => { throw new Error('expected'); });
test('${name} runs after the failure', async () => {
  expect(hookRunsBefore).toBeGreaterThan(0);
});`;
      const { outcome, project } = await runProjectWithConfigFile(
        { ...SUPPORT, 'tests/a.e2e.ts': file('a'), 'tests/b.e2e.ts': file('b') },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      for (const name of ['a', 'b']) {
        expect(resultByTitle(outcome, `${name} fails`).status).toBe('failed');
        expect(resultByTitle(outcome, `${name} runs after the failure`).status).toBe('passed');
      }
      // Each file has the helper's test under its own path.
      expect(outcome.results.filter((result) => result.test.title === 'from the helper').map((result) => [result.test.file, result.status])).toEqual([
        ['tests/a.e2e.ts', 'passed'],
        ['tests/b.e2e.ts', 'passed'],
      ]);
    },
    120_000,
  );
});
