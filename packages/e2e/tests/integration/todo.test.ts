import { describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import { listProject, resultByTitle, runProject } from '../helpers/run-project.ts';

const TODO_TEST = `import { test } from 'e2e';

test.describe('checkout', () => {
  test.describe('purchase flow', () => {
    test.todo('add checkout coverage');
  });
});
`;

const TODO_AND_SKIP_TEST = `import { test } from 'e2e';

test.todo('add checkout coverage');
test.skip('parked coverage', async () => {});
`;

const RUNNABLE_AND_TODO_TEST = `import { test } from 'e2e';

test('ready', async () => {});
test.todo('future');
`;

const SERIAL_TODO_TEST = `import { describe, test } from 'e2e';

describe('wizard', { serial: true }, () => {
  test('ready', async () => {});
  test.todo('future');
});
`;

describe('test.todo', () => {
  it('reports a nested todo without running it and exits successfully', async () => {
    const { outcome, project } = await runProject({ 'tests/checkout.e2e.ts': TODO_TEST }, {});
    try {
      const result = resultByTitle(outcome, 'add checkout coverage');
      expect(outcome.exitCode).toBe(0);
      expect(result).toMatchObject({ status: 'todo', selected: true, attempts: [] });
      expect(result.test.titlePath).toEqual(['checkout', 'purchase flow', 'add checkout coverage']);
      expect(outcome.report.run.summary).toMatchObject({
        discovered: 1,
        selected: 1,
        executed: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        todo: 1,
      });
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('keeps todo visible in list selection', async () => {
    const { pairs, project } = await listProject({ 'tests/checkout.e2e.ts': TODO_TEST }, {});
    try {
      expect(pairs).toHaveLength(1);
      expect(pairs[0]).toMatchObject({
        titlePath: ['checkout', 'purchase flow', 'add checkout coverage'],
        disposition: 'todo',
      });
    } finally {
      project.cleanup();
    }
  });

  it('keeps a serial TODO unexecuted when its sibling is selected by --grep', async () => {
    const { outcome, project } = await runProject({ 'tests/checkout.e2e.ts': SERIAL_TODO_TEST }, { runOptions: { grep: [/ready/] } });
    try {
      const todo = resultByTitle(outcome, 'future');
      expect(outcome.exitCode).toBe(0);
      expect(todo).toMatchObject({ status: 'todo', attempts: [] });
      expect(outcome.report.run.summary).toMatchObject({ executed: 1, passed: 1, todo: 1 });
    } finally {
      project.cleanup();
    }
  });

  it('keeps a serial TODO unexecuted when its sibling is selected by file:line', async () => {
    const listed = await listProject({ 'tests/checkout.e2e.ts': SERIAL_TODO_TEST }, {});
    let readySource: { file: string; line: number } | undefined;
    try {
      readySource = listed.pairs.find((pair) => pair.title === 'ready')?.source;
    } finally {
      listed.project.cleanup();
    }
    if (readySource === undefined) throw new Error('The ready test has no source location');

    const { outcome, project } = await runProject({ 'tests/checkout.e2e.ts': SERIAL_TODO_TEST }, {
      runOptions: { files: [`${readySource.file}:${readySource.line}`] },
    });
    try {
      const todo = resultByTitle(outcome, 'future');
      expect(outcome.exitCode).toBe(0);
      expect(todo).toMatchObject({ status: 'todo', attempts: [] });
      expect(outcome.report.run.summary).toMatchObject({ executed: 1, passed: 1, todo: 1 });
    } finally {
      project.cleanup();
    }
  });

  it('lets a TODO-only run pass but reports an empty shard as NO_TESTS', async () => {
    const { outcome: unsharded, project: unshardedProject } = await runProject({ 'tests/checkout.e2e.ts': TODO_TEST }, {});
    try {
      expect(unsharded.exitCode).toBe(0);
      expect(resultByTitle(unsharded, 'add checkout coverage')).toMatchObject({ status: 'todo', selected: true, attempts: [] });
    } finally {
      unshardedProject.cleanup();
    }

    const { outcome: firstShard, project: firstProject } = await runProject(
      { 'tests/checkout.e2e.ts': TODO_TEST },
      { runOptions: { shard: { index: 1, total: 2 } } },
    );
    try {
      expect(firstShard.exitCode).toBe(0);
      expect(resultByTitle(firstShard, 'add checkout coverage')).toMatchObject({ status: 'todo', selected: true, attempts: [] });
    } finally {
      firstProject.cleanup();
    }

    const { outcome: emptyShard, project: emptyProject } = await runProject(
      { 'tests/checkout.e2e.ts': TODO_TEST },
      { runOptions: { shard: { index: 2, total: 2 } } },
    );
    try {
      expect(emptyShard.exitCode).toBe(2);
      expect(emptyShard.report.run.errors).toEqual([expect.objectContaining({ code: 'NO_TESTS', phase: 'collection' })]);
    } finally {
      emptyProject.cleanup();
    }

    const { outcome: allowedEmptyShard, project: allowedProject } = await runProject(
      { 'tests/checkout.e2e.ts': TODO_TEST },
      { runOptions: { shard: { index: 2, total: 2 }, passWithNoTests: true } },
    );
    try {
      expect(allowedEmptyShard.exitCode).toBe(0);
      expect(resultByTitle(allowedEmptyShard, 'add checkout coverage')).toMatchObject({
        status: 'skipped',
        selected: false,
        skip: { cause: 'filtered', reason: 'outside the shard' },
      });
    } finally {
      allowedProject.cleanup();
    }
  });

  it('reports NO_TESTS when a shard selects no runnable test alongside TODOs', async () => {
    for (const source of [TODO_AND_SKIP_TEST, RUNNABLE_AND_TODO_TEST]) {
      const { outcome, project } = await runProject(
        { 'tests/checkout.e2e.ts': source },
        { runOptions: { shard: { index: 2, total: 2 } } },
      );
      try {
        expect(outcome.exitCode).toBe(2);
        expect(outcome.report.run.errors).toEqual([expect.objectContaining({ code: 'NO_TESTS', phase: 'collection' })]);
      } finally {
        project.cleanup();
      }
    }
  });
});
