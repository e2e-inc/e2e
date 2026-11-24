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
export async function declareLater(title: string): Promise<void> {
  await Promise.resolve();
  test(title, async () => {});
}
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
import { declareLater, declareTest } from './library.ts';
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
await declareLater('from the library, later');
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
        ['from the library, later', 'passed'],
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

  it(
    'evaluates the module once per import of the file, however often the file imports it',
    async () => {
      const { outcome, project } = await runProjectWithConfigFile(
        {
          ...SUPPORT,
          'tests/file.e2e.ts': `import { expect, test } from 'e2e';
import './helper.ts';
import { state } from './state.ts';

// A second spelling of the helper, resolved once the first import made it a registrar.
await import('./helper');
test.describe.configure({ parallel: true });
for (const title of ['one', 'two']) {
  test(title, async () => {
    const loads = state.helperLoads;
    await import('./helper.ts');
    expect(state.helperLoads).toBe(loads);
  });
}`,
        },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.title, result.status])).toEqual([
        ['from the helper', 'passed'],
        ['one', 'passed'],
        ['two', 'passed'],
      ]);
    },
    120_000,
  );

  it(
    'keeps every file in order that imports a module with nothing but describe.configure',
    async () => {
      // A file cut into several units is imported once per unit, and each import starts the count again.
      const file = (name: string): string => `import { expect, test } from 'e2e';
import './ordered.ts';

let ran = 0;
test('${name} first', async () => { ran += 1; });
test('${name} second', async () => { expect(ran).toBe(1); });`;
      const { outcome, project } = await runProjectWithConfigFile(
        {
          'tests/ordered.ts': `import { test } from 'e2e';\ntest.describe.configure({ parallel: false });\n`,
          'tests/a.e2e.ts': file('a'),
          'tests/b.e2e.ts': file('b'),
        },
        { configSource: workerFakeConfigSource(2, '\n  fullyParallel: true,') },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.title, result.status]).toSorted()).toEqual([
        ['a first', 'passed'],
        ['a second', 'passed'],
        ['b first', 'passed'],
        ['b second', 'passed'],
      ]);
    },
    120_000,
  );

  it.each([
    ['the file that imports it directly comes first', './helper.ts', './between.ts'],
    ['the file that imports it through another module comes first', './between.ts', './helper.ts'],
  ])(
    'reach a file that imports the module through another one, when %s',
    async (_order, first, second) => {
      const file = (name: string, helper: string): string => `import { test } from 'e2e';
import '${helper}';

test('${name}', async () => {});`;
      const { outcome, project } = await runProjectWithConfigFile(
        { ...SUPPORT, 'tests/between.ts': `import './helper.ts';\n`, 'tests/a.e2e.ts': file('a', first), 'tests/b.e2e.ts': file('b', second) },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.file, result.test.title, result.status])).toEqual([
        ['tests/a.e2e.ts', 'from the helper', 'passed'],
        ['tests/a.e2e.ts', 'a', 'passed'],
        ['tests/b.e2e.ts', 'from the helper', 'passed'],
        ['tests/b.e2e.ts', 'b', 'passed'],
      ]);
    },
    120_000,
  );
});
