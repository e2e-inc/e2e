/**
 * `--since-last-run` (`sinceLastRun`) through the runner, the public
 * `e2e/runner` API, and the built CLI on the fake engine: the first run
 * records the working tree and the tests that passed, a run with nothing
 * changed runs nothing, an uncommitted edit goes to the filters with the
 * tests the record settled, a test that did not pass runs unasked, and a
 * narrowed run keeps the tree the rest is measured from. Each project is its
 * own git repository with one commit; nothing here commits again.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Report1Document } from '../../src/report/build.ts';
import { renderMarkdownReport } from '../../src/report/markdown.ts';
import type { RunOptions } from '../../src/run/runner.ts';
import type { E2EConfig, TestFilter, TestFilterCandidate, TestFilterContext } from '../../src/run-types.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { commitFiles, initRepo, runGit } from '../helpers/git-repo.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, listExisting, runExisting, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const runnerModule = new URL('../../dist/runner.js', import.meta.url).href;
const publicRunner = (await import(runnerModule)) as typeof import('../../src/runner.ts');
const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

/** The environment of every run here: outside CI. */
const LOCAL_ENV: NodeJS.ProcessEnv = { ...process.env, CI: '', GITHUB_ACTIONS: '' };

function testFile(title: string, body = ''): string {
  return `import { test } from 'e2e';\ntest(${JSON.stringify(title)}, async () => {${body}});\n`;
}

const THREE_TESTS = {
  'tests/alpha.e2e.ts': testFile('alpha'),
  'tests/beta.e2e.ts': testFile('beta'),
  'tests/gamma.e2e.ts': testFile('gamma'),
} as const;

/** A fixture project removed after the test, made a git repository with `files` and `src/app.ts` committed; what a run writes under `.e2e` stays untracked and not ignored. */
function fixture(files: Readonly<Record<string, string>> = THREE_TESTS): FixtureProject {
  const created = createProject(files);
  projects.push(created);
  initRepo(created.dir);
  commitFiles(created.dir, { 'src/app.ts': 'export const version = 1;\n' }, 'base');
  return created;
}

function titleOf(test: TestFilterCandidate): string {
  return test.titlePath.at(-1)!;
}

/** A filter named `areas` that leaves out every test but those titled `keep`, with `calls` recording what each call was handed. */
function keepOnly(keep: readonly string[]) {
  const calls: { readonly tests: readonly string[]; readonly context: TestFilterContext }[] = [];
  const filter: TestFilter = {
    name: 'areas',
    filter: (tests, context) => {
      calls.push({ tests: tests.map(titleOf), context });
      return { exclude: Object.fromEntries(tests.filter((test) => !keep.includes(titleOf(test))).map((test) => [test.id, `the diff misses ${titleOf(test)}`])) };
    },
  };
  return { filter, calls };
}

/** One `--since-last-run` run of `project` outside CI, with the filter notices it wrote. */
async function run(project: FixtureProject, config: Partial<E2EConfig> = {}, runOptions: Partial<RunOptions> = {}) {
  const notices: string[] = [];
  const outcome = await runExisting(project, {
    config,
    runOptions: {
      env: LOCAL_ENV,
      sinceLastRun: true,
      onEvent: (event) => {
        if (event.type === 'notice' && event.target === 'filter') notices.push(event.message);
      },
      ...runOptions,
    },
  });
  return { outcome, notices, report: outcome.report as Report1Document };
}

/** The titles of the ordinary tests the run executed, sorted. */
function executed(report: Report1Document): string[] {
  return report.run.results
    .filter((result) => result.kind === 'test' && result.selected)
    .map((result) => result.titlePath.at(-1)!)
    .toSorted();
}

interface RecordDocument {
  readonly schemaVersion: string;
  readonly settled: Record<string, { readonly testId: string; readonly tree: string; readonly tracked: string }>;
}

function readRecord(project: FixtureProject): RecordDocument {
  return JSON.parse(readFileSync(path.join(project.dir, '.e2e', 'since-last-run.json'), 'utf8')) as RecordDocument;
}

/** The tree of tracked files recorded beside `tree`, which a filter diffs. */
function trackedOf(project: FixtureProject, tree: string): string {
  const entry = Object.values(readRecord(project).settled).find((settled) => settled.tree === tree);
  if (entry === undefined) throw new Error(`no settled test at ${tree}`);
  return entry.tracked;
}

/** The record the last run left in `project`: the tree each settled test passed against, by the title the test has in one of `reports`, sorted by title. */
function recordOf(project: FixtureProject, ...reports: readonly Report1Document[]): Record<string, string> {
  const record = readRecord(project);
  expect(record.schemaVersion).toBe('since-last-run-1');
  const titles = new Map(reports.flatMap((report) => report.run.results.map((result) => [result.testId, result.titlePath.at(-1)!] as const)));
  return Object.fromEntries(Object.values(record.settled).map(({ testId, tree }) => [titles.get(testId) ?? testId, tree] as const).toSorted(([a], [b]) => a.localeCompare(b)));
}

/** The one tree every settled test of the record shares. */
function treeOf(record: Record<string, string>): string {
  const trees = [...new Set(Object.values(record))];
  expect(trees).toHaveLength(1);
  return trees[0]!;
}

function edit(project: FixtureProject, file: string, content: string): void {
  writeFileSync(path.join(project.dir, file), content);
}

describe('--since-last-run', () => {
  it('runs every test and records the working tree first, then runs nothing until a file changes', async () => {
    const project = fixture();
    const { filter, calls } = keepOnly([]);
    const first = await run(project, { filters: [filter] });
    expect(first.report.run.errors).toEqual([]);
    expect(first.outcome.exitCode).toBe(0);
    expect(executed(first.report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(first.notices).toEqual(['--since-last-run: no run has recorded the working tree yet, so every test runs']);
    expect(first.report.run.changes).toEqual({ skipped: 'no run has recorded the working tree yet' });
    expect(calls).toEqual([]);
    const recorded = recordOf(project, first.report);
    expect(Object.keys(recorded)).toEqual(['alpha', 'beta', 'gamma']);
    const tree = treeOf(recorded);
    // The tree holds the checkout as it is, and nothing of what the run wrote under the output.
    expect(runGit(project.dir, 'ls-tree', '-r', '--name-only', tree).split('\n')).toEqual(['file.txt', 'src/app.ts', 'tests/alpha.e2e.ts', 'tests/beta.e2e.ts', 'tests/gamma.e2e.ts']);
    // The checkout's own index is left as it was: nothing staged.
    expect(runGit(project.dir, 'status', '--porcelain')).toBe('?? .e2e/');

    const second = await run(project, { filters: [filter] });
    expect(second.report.run.errors).toEqual([]);
    expect(second.outcome.exitCode).toBe(0);
    expect(executed(second.report)).toEqual([]);
    expect(second.notices).toEqual(['no files changed since the last run', 'since-last-run left out all 3 tests']);
    expect(second.report.run.changes).toEqual({ files: 0, since: 'last-run' });
    expect(second.report.run.filters).toEqual([{ name: 'since-last-run', candidates: 3, excluded: 3 }]);
    expect(second.report.run.results.map((result) => result.skip)).toEqual(
      Array.from({ length: 3 }, () => ({ cause: 'filtered', filter: 'since-last-run', reason: 'no file changed since the test last passed' })),
    );
    assertValidReport(second.report);
    expect(calls).toEqual([]);
    expect(recordOf(project, first.report)).toEqual(recorded);
  });

  it('hands the filters an uncommitted change with the trees it runs between, and settles what they decided against the new tree', async () => {
    const project = fixture();
    const { filter, calls } = keepOnly(['alpha']);
    const first = await run(project, { filters: [filter] });
    const before = treeOf(recordOf(project, first.report));
    const trackedBefore = trackedOf(project, before);

    edit(project, 'src/app.ts', 'export const version = 2;\n');
    edit(project, 'src/new.ts', 'export const added = true;\n');
    const second = await run(project, { filters: [filter] });
    expect(second.report.run.errors).toEqual([]);
    expect(executed(second.report)).toEqual(['alpha']);
    expect(second.notices).toEqual(['judging 2 files changed since the last run', 'areas kept 1 of 3 tests, left out 2']);
    // A test the filter judged unaffected is settled against the new tree with the one that ran.
    const settled = recordOf(project, first.report);
    expect(Object.keys(settled)).toEqual(['alpha', 'beta', 'gamma']);
    const after = treeOf(settled);
    expect(after).not.toBe(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tests).toEqual(['alpha', 'beta', 'gamma']);
    // Every file that differs is listed; the trees to diff hold the tracked files alone, so no contents of an untracked one.
    const changes = { base: trackedBefore, head: trackedOf(project, after), root: runGit(project.dir, 'rev-parse', '--show-toplevel'), files: ['src/app.ts', 'src/new.ts'] };
    expect(calls[0]!.context.changes).toEqual(changes);
    expect(runGit(project.dir, 'diff', '--name-status', before, after)).toBe('M\tsrc/app.ts\nA\tsrc/new.ts');
    expect(runGit(project.dir, 'diff', '--name-status', changes.base, changes.head)).toBe('M\tsrc/app.ts');
    expect(second.report.run.changes).toEqual({ files: 2, since: 'last-run' });
    expect(second.report.run.filters).toEqual([{ name: 'areas', candidates: 3, excluded: 2 }]);
    expect(renderMarkdownReport(second.report)).toContain('**Change** 2 files changed since the last run');
    assertValidReport(second.report);

    const third = await run(project, { filters: [filter] });
    expect(executed(third.report)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('runs a test that did not pass again without asking, until it passes', async () => {
    const project = fixture({ ...THREE_TESTS, 'tests/gamma.e2e.ts': testFile('gamma', " throw new Error('gamma broke'); ") });
    const { filter, calls } = keepOnly([]);
    const first = await run(project, { filters: [filter] });
    expect(first.outcome.exitCode).toBe(1);
    expect(Object.keys(recordOf(project, first.report))).toEqual(['alpha', 'beta']);

    // Nothing changed: the failure alone runs.
    const second = await run(project, { filters: [filter] });
    expect(second.outcome.exitCode).toBe(1);
    expect(executed(second.report)).toEqual(['gamma']);
    expect(second.notices).toEqual(['no files changed since the last run; 1 test runs unasked', 'since-last-run left out all 2 tests']);

    // The fix is a change: the filter judges the settled tests, never the owed one.
    edit(project, 'tests/gamma.e2e.ts', testFile('gamma'));
    const third = await run(project, { filters: [filter] });
    expect(third.outcome.exitCode).toBe(0);
    expect(executed(third.report)).toEqual(['gamma']);
    expect(calls.map((call) => call.tests)).toEqual([['alpha', 'beta']]);
    expect(third.notices[0]).toBe('judging 1 file changed since the last run; 1 test runs unasked');
    expect(Object.keys(recordOf(project, first.report))).toEqual(['alpha', 'beta', 'gamma']);

    const fourth = await run(project, { filters: [filter] });
    expect(executed(fourth.report)).toEqual([]);
  });

  it('runs every settled test on a change when the config has no filters, and none without one', async () => {
    const project = fixture();
    await run(project);
    const unchanged = await run(project);
    expect(executed(unchanged.report)).toEqual([]);

    edit(project, 'src/app.ts', 'export const version = 2;\n');
    const changed = await run(project);
    expect(executed(changed.report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(changed.notices).toEqual(['1 file changed since the last run and the config has no filters, so 3 tests run']);
    expect(changed.report.run.changes).toMatchObject({ files: 1, since: 'last-run', skipped: 'the config has no filters' });
    assertValidReport(changed.report);
    expect(executed((await run(project)).report)).toEqual([]);
  });

  it('keeps the tree of a test a narrowed run leaves out, so the next run still judges it against the whole change', async () => {
    const project = fixture();
    const { filter, calls } = keepOnly(['beta']);
    const first = await run(project, { filters: [filter] });
    const before = treeOf(recordOf(project, first.report));

    edit(project, 'src/app.ts', 'export const version = 2;\n');
    const narrowed = await run(project, { filters: [filter] }, { grep: [/alpha/u] });
    expect(executed(narrowed.report)).toEqual([]);
    expect(calls.map((call) => call.tests)).toEqual([['alpha']]);
    const after = recordOf(project, first.report);
    expect(after).toEqual({ alpha: calls[0]!.context.changes.head, beta: before, gamma: before });

    // Nothing changed for alpha since; beta and gamma are still judged from the tree they passed against.
    const full = await run(project, { filters: [filter] });
    expect(executed(full.report)).toEqual(['beta']);
    expect(calls.at(-1)!.tests).toEqual(['beta', 'gamma']);
    expect(calls.at(-1)!.context.changes).toMatchObject({ base: before, files: ['src/app.ts'] });
    expect(full.report.run.filters).toEqual([
      { name: 'since-last-run', candidates: 1, excluded: 1 },
      { name: 'areas', candidates: 2, excluded: 1 },
    ]);
    assertValidReport(full.report);
    treeOf(recordOf(project, first.report));
  });

  it('runs a test again once a fix it passed on is reverted, though the working tree is the one the rest passed against', async () => {
    const broken = testFile('gamma', " throw new Error('gamma broke'); ");
    const project = fixture({ ...THREE_TESTS, 'tests/gamma.e2e.ts': broken });
    await run(project);
    edit(project, 'tests/gamma.e2e.ts', testFile('gamma'));
    const fixed = await run(project, {}, { grep: [/gamma/u] });
    expect(executed(fixed.report)).toEqual(['gamma']);
    expect(fixed.outcome.exitCode).toBe(0);

    edit(project, 'tests/gamma.e2e.ts', broken);
    const reverted = await run(project);
    expect(executed(reverted.report)).toEqual(['gamma']);
    expect(reverted.outcome.exitCode).toBe(1);
    expect(reverted.notices).toEqual(['1 file changed since the last run and the config has no filters, so 1 test runs', 'since-last-run left out all 2 tests']);
  });

  it('runs a test whose tree is not the one the filters judge from, without asking', async () => {
    const project = fixture();
    const { filter, calls } = keepOnly([]);
    await run(project, { filters: [filter] });
    edit(project, 'src/app.ts', 'export const version = 2;\n');
    await run(project, { filters: [filter] }, { grep: [/alpha/u] });
    edit(project, 'src/app.ts', 'export const version = 3;\n');

    // beta and gamma share the first tree, alpha passed against the second: one call judges the two, alpha runs.
    const full = await run(project, { filters: [filter] });
    expect(calls.at(-1)!.tests).toEqual(['beta', 'gamma']);
    expect(executed(full.report)).toEqual(['alpha']);
    expect(full.notices[0]).toBe('judging 1 file changed since the last run; 1 test runs unasked');
  });

  it('drops a deleted test from the record and runs a new one unasked', async () => {
    const project = fixture();
    const { filter, calls } = keepOnly([]);
    const first = await run(project, { filters: [filter] });
    rmSync(path.join(project.dir, 'tests', 'gamma.e2e.ts'));
    edit(project, 'tests/delta.e2e.ts', testFile('delta'));
    const second = await run(project, { filters: [filter] });
    expect(executed(second.report)).toEqual(['delta']);
    expect(calls.map((call) => call.tests)).toEqual([['alpha', 'beta']]);
    const settled = recordOf(project, first.report, second.report);
    expect(Object.keys(settled)).toEqual(['alpha', 'beta', 'delta']);
    expect(trackedOf(project, treeOf(settled))).toBe(calls[0]!.context.changes.head);
  });

  it('settles no test a repeat failed, and runs a serial group whole for the member that failed', async () => {
    const flaky = "import { test } from 'e2e';\nlet runs = 0;\ntest('alpha', async () => { runs += 1; if (runs === 2) throw new Error('second repeat broke'); });\n";
    const serial = "import { test } from 'e2e';\ntest.describe('flow', { serial: true }, () => {\n  test('first', async () => {});\n  test('second', async () => { throw new Error('second broke'); });\n});\n";
    const project = fixture({ 'tests/alpha.e2e.ts': flaky, 'tests/beta.e2e.ts': testFile('beta'), 'tests/flow.e2e.ts': serial });
    const first = await run(project, {}, { repeatEach: 2 });
    expect(first.outcome.exitCode).toBe(1);
    expect(recordOf(project, first.report)).toEqual({ beta: expect.any(String), first: expect.any(String) });

    // Nothing changed: beta is left out, and the serial group runs whole for its failed member.
    const second = await run(project);
    expect(executed(second.report)).toEqual(['alpha', 'first', 'second']);
  });

  it('leaves the filters out of a --last-failed rerun, and settles what it ran', async () => {
    const project = fixture({ ...THREE_TESTS, 'tests/gamma.e2e.ts': testFile('gamma', " throw new Error('gamma broke'); ") });
    const { filter, calls } = keepOnly([]);
    const first = await run(project, { filters: [filter] });
    const before = recordOf(project, first.report);
    edit(project, 'tests/gamma.e2e.ts', testFile('gamma'));
    const rerun = await run(project, { filters: [filter] }, { lastFailed: true });
    expect(executed(rerun.report)).toEqual(['gamma']);
    expect(rerun.notices).toEqual(['--last-failed: the tests the last run owes run without filters']);
    expect(calls).toEqual([]);
    const after = recordOf(project, first.report);
    expect(after).toEqual({ ...before, gamma: expect.any(String) });
    expect(after['gamma']).not.toBe(before['alpha']);

    // alpha and beta were not judged against the fix: the next run asks about them.
    const next = await run(project, { filters: [filter] });
    expect(executed(next.report)).toEqual([]);
    expect(calls.map((call) => call.tests)).toEqual([['alpha', 'beta']]);
  });

  it('runs what a filter that throws was asked about, and settles it against the new tree once it passes', async () => {
    const project = fixture();
    const throwing: TestFilter = { name: 'areas', filter: () => { throw new Error('no model'); } };
    const first = await run(project, { filters: [throwing] });
    edit(project, 'src/app.ts', 'export const version = 2;\n');
    const second = await run(project, { filters: [throwing] });
    expect(executed(second.report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(second.notices).toEqual(['judging 1 file changed since the last run', 'warning: areas failed, so it leaves nothing out: no model']);
    expect(executed((await run(project, { filters: [throwing] })).report)).toEqual([]);
    treeOf(recordOf(project, first.report));
  });

  it('starts over when the record is not one, and runs a test whose tree git no longer holds', async () => {
    const project = fixture();
    const first = await run(project);
    const file = path.join(project.dir, '.e2e', 'since-last-run.json');
    const record = readRecord(project);
    const pruned = Object.fromEntries(Object.entries(record.settled).map(([id, entry]) => [id, { ...entry, tree: 'a'.repeat(entry.tree.length) }]));
    writeFileSync(file, JSON.stringify({ ...record, settled: pruned }));
    const gone = await run(project);
    expect(executed(gone.report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(gone.notices).toEqual(['git no longer holds the working tree 3 tests last passed against, so no filter ran']);
    expect(gone.report.run.changes).toEqual({ skipped: 'git no longer holds the working tree 3 tests last passed against' });
    expect(recordOf(project, first.report)).toEqual(Object.fromEntries(Object.values(record.settled).map((entry) => [entry.testId.split('::').at(-1), entry.tree])));

    writeFileSync(file, '{');
    const corrupt = await run(project);
    expect(executed(corrupt.report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(corrupt.notices).toEqual(["--since-last-run: the last run's record is not a since-last-run-1 document, so every test runs"]);
  });

  it('runs a test again that a run without the flag saw fail, though no file changed', async () => {
    const project = fixture({ ...THREE_TESTS, 'tests/gamma.e2e.ts': testFile('gamma', " if (process.env['GAMMA_FAILS'] === '1') throw new Error('gamma broke'); ") });
    const first = await run(project);
    expect(Object.keys(recordOf(project, first.report))).toEqual(['alpha', 'beta', 'gamma']);

    process.env['GAMMA_FAILS'] = '1';
    try {
      const plain = await run(project, {}, { sinceLastRun: false });
      expect(plain.outcome.exitCode).toBe(1);
      expect(Object.keys(recordOf(project, first.report))).toEqual(['alpha', 'beta']);
      const next = await run(project);
      expect(executed(next.report)).toEqual(['gamma']);
      expect(next.outcome.exitCode).toBe(1);
    } finally {
      delete process.env['GAMMA_FAILS'];
    }
    // A pass without the flag settles nothing: only a recorded tree can.
    await run(project, {}, { sinceLastRun: false });
    expect(executed((await run(project)).report)).toEqual(['gamma']);
    expect(executed((await run(project)).report)).toEqual([]);
  });

  it('leaves out a test that skipped itself, so a run with nothing changed starts nothing', async () => {
    const project = fixture({ ...THREE_TESTS, 'tests/gamma.e2e.ts': testFile('gamma', " test.skip(true, 'not here'); ") });
    const first = await run(project);
    expect(Object.keys(recordOf(project, first.report))).toEqual(['alpha', 'beta', 'gamma']);
    const second = await run(project);
    expect(executed(second.report)).toEqual([]);
    expect(second.notices).toEqual(['no files changed since the last run', 'since-last-run left out all 3 tests']);
  });

  it('runs every test under another config that shares the output, and starts a record of its own', async () => {
    const project = fixture();
    await run(project);
    expect(executed((await run(project)).report)).toEqual([]);

    const other = await run(project, { retries: 1 });
    expect(executed(other.report)).toEqual(['alpha', 'beta', 'gamma']);
    expect(other.notices).toEqual(["--since-last-run: the last run's record is of another config, so every test runs"]);
    expect(executed((await run(project, { retries: 1 })).report)).toEqual([]);
  });

  it('lists what a run would leave out without moving the record, through the public list() and run()', async () => {
    const project = fixture();
    const config = { targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }] } satisfies E2EConfig;
    const ran = await publicRunner.run({ cwd: project.dir, config, sinceLastRun: true });
    expect(ran.exitCode).toBe(0);
    const file = path.join(project.dir, '.e2e', 'since-last-run.json');
    const record = readFileSync(file, 'utf8');

    const unchanged = await listExisting(project, { config, sinceLastRun: true });
    expect(unchanged.pairs.map((pair) => [pair.title, pair.disposition, pair.filter])).toEqual(['alpha', 'beta', 'gamma'].map((title) => [title, 'filtered', 'since-last-run']));

    edit(project, 'src/app.ts', 'export const version = 2;\n');
    const changed = await publicRunner.list({ cwd: project.dir, config, sinceLastRun: true });
    expect(changed.pairs.map((pair) => pair.disposition)).toEqual(['run', 'run', 'run']);
    expect(readFileSync(file, 'utf8')).toBe(record);
  });

  it('refuses both ways of naming the change at once, before anything runs', async () => {
    const project = fixture();
    const { outcome } = await run(project, {}, { changedSince: 'main' });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.report.run.errors.map((error) => error.code)).toEqual(['INVALID_CONFIG']);
    expect(existsSync(path.join(project.dir, '.e2e', 'since-last-run.json'))).toBe(false);
  });

  it('refuses a filter named since-last-run', async () => {
    const project = fixture();
    const { outcome } = await run(project, { filters: [{ name: 'since-last-run', filter: () => ({ exclude: {} }) }] });
    expect(outcome.report.run.errors.map((error) => error.message)).toEqual(['filter name "since-last-run" is taken: --since-last-run reports the tests it leaves out under it']);
  });

  it('runs through the CLI: e2e run --since-last-run twice, then e2e list', () => {
    const project = fixture({
      ...THREE_TESTS,
      'e2e.config.ts': `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }],
  workers: 1,
  cache: 'off',
} satisfies E2EConfig;
`,
    });
    const cli = (...args: string[]) => {
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd: project.dir, env: { ...LOCAL_ENV, NO_COLOR: '1' }, encoding: 'utf8', timeout: 60_000 });
      expect(result.error).toBeUndefined();
      return { exitCode: result.status, output: result.stdout + result.stderr };
    };
    const first = cli('run', '--since-last-run', '--reporter', 'list');
    expect(first.exitCode).toBe(0);
    expect(first.output).toContain('--since-last-run: no run has recorded the working tree yet, so every test runs');
    expect(first.output).toContain('3 passed');

    const second = cli('run', '--since-last-run', '--reporter', 'list');
    expect(second.exitCode).toBe(0);
    expect(second.output).toContain('no files changed since the last run');
    expect(second.output).toContain('since-last-run left out all 3 tests');

    edit(project, 'src/app.ts', 'export const version = 2;\n');
    const listed = cli('list', '--since-last-run');
    expect(listed.exitCode).toBe(0);
    expect(listed.output).toContain('1 file changed since the last run and the config has no filters, so 3 tests run');

    const both = cli('run', '--since-last-run', '--changed-since', 'main');
    expect(both.exitCode).toBe(2);
    expect(both.output).toContain('--since-last-run and --changed-since each name what the change is measured from; pass one');
  });
});
