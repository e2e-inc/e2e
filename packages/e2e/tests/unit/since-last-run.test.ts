/**
 * What `--since-last-run` records and measures, in real throwaway git
 * repositories: the working tree as a tree object that leaves the checkout's
 * index alone, every way there is no record to measure from, how a selection
 * splits by the tree each test last passed against, and what a run's report
 * settles for the next.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import { resultId } from '@e2e-dev/core/lib/internal/ids';
import type { TestTargetPair } from '../../src/collect/select.ts';
import type { Report1Document } from '../../src/report/build.ts';
import type { TestFilterCandidate } from '../../src/run-types.ts';
import { measureSinceLastRun, planSinceLastRun, recordSinceLastRun, type SettledTests, type SinceLastRun } from '../../src/run/since-last-run.ts';
import { commitFiles, initRepo, runGit, useTempDirs } from '../helpers/git-repo.ts';

const tempDir = useTempDirs();
const live = () => new AbortController().signal;
/** The digest of the config every project here runs under. */
const DIGEST = 'd'.repeat(64);

/** Measures the project at `cwd`, its output at `.e2e` and its cache at `.e2e/cache` there. */
function measure(cwd: string, interrupt = live(), budgetMs?: number): Promise<SinceLastRun> {
  const output = path.join(cwd, '.e2e');
  return measureSinceLastRun({ projectRoot: cwd, output, cache: { mode: 'off', store: undefined, dir: path.join(output, 'cache'), strict: false }, configDigest: DIGEST }, interrupt, budgetMs);
}

/** Writes `content` as the record of the project at `cwd`. */
function writeRecord(cwd: string, content: string): void {
  mkdirSync(path.join(cwd, '.e2e'), { recursive: true });
  writeFileSync(path.join(cwd, '.e2e', 'since-last-run.json'), content);
}

function filesIn(dir: string, tree: string): string[] {
  return runGit(dir, 'ls-tree', '-r', '--name-only', tree).split('\n');
}

describe('measureSinceLastRun', () => {
  it('records tracked, staged, and untracked files, never an ignored one or the output, and leaves the index as it was', async () => {
    const dir = tempDir();
    initRepo(dir);
    commitFiles(dir, { 'src/app.ts': 'one\n', '.gitignore': 'build/\n', '.e2e/cache/committed.json': '{}\n' });
    writeFileSync(path.join(dir, 'staged.ts'), 'new\n');
    runGit(dir, 'add', 'staged.ts');
    writeFileSync(path.join(dir, 'src', 'app.ts'), 'two\n');
    writeFileSync(path.join(dir, 'untracked.ts'), 'new\n');
    rmSync(path.join(dir, 'file.txt'));
    mkdirSync(path.join(dir, 'build'));
    writeFileSync(path.join(dir, 'build', 'out.js'), 'ignored\n');
    writeFileSync(path.join(dir, '.e2e', 'report.json'), '{}\n');
    const status = runGit(dir, 'status', '--porcelain');

    const measured = await measure(dir);
    expect(measured).toEqual({ root: realpathSync(dir), tree: measured.tree, tracked: measured.tracked, configDigest: DIGEST, settled: new Map(), missing: 'no run has recorded the working tree yet' });
    // Nothing under the output, not even what a commit holds there.
    expect(filesIn(dir, measured.tree)).toEqual(['.gitignore', 'src/app.ts', 'staged.ts', 'untracked.ts']);
    // The tracked tree holds what the index knows, as the working tree has it, and no untracked file.
    expect(filesIn(dir, measured.tracked)).toEqual(['.gitignore', 'src/app.ts', 'staged.ts']);
    for (const tree of [measured.tree, measured.tracked]) expect(runGit(dir, 'show', `${tree}:src/app.ts`)).toBe('two');
    expect(runGit(dir, 'status', '--porcelain')).toBe(status);
  });

  it('records an edit of the same size made in the second the index was written', async () => {
    const dir = tempDir();
    initRepo(dir);
    const file = path.join(dir, 'src', 'app.ts');
    const second = () => Math.floor(statSync(file).mtimeMs / 1000);
    // Until the file is committed and edited within one second: only then are its size and time what the index holds.
    let sameSecond = false;
    for (let version = 1; version < 100 && !sameSecond; version += 2) {
      commitFiles(dir, { 'src/app.ts': `export const version = ${version % 9};\n` });
      const committed = second();
      writeFileSync(file, `export const version = ${(version + 1) % 9};\n`);
      sameSecond = second() === committed;
    }
    expect(sameSecond).toBe(true);
    await sleep(1100);
    const measured = await measure(dir);
    expect(runGit(dir, 'show', `${measured.tree}:src/app.ts`)).toBe(readFileSync(file, 'utf8').trim());
  });

  it('records the whole repository from a project in a subdirectory, its output left out, and a repository with no commit', async () => {
    const dir = tempDir();
    runGit(dir, 'init', '--quiet');
    const project = path.join(dir, 'apps', 'web');
    mkdirSync(path.join(project, '.e2e', 'cache'), { recursive: true });
    writeFileSync(path.join(project, 'page.ts'), 'page\n');
    writeFileSync(path.join(project, '.e2e', 'report.json'), '{}\n');
    writeFileSync(path.join(project, '.e2e', 'cache', 'entry.json'), '{}\n');
    writeFileSync(path.join(dir, 'shared.ts'), 'shared\n');
    const first = await measure(project);
    expect(first.root).toBe(realpathSync(dir));
    expect(filesIn(dir, first.tree)).toEqual(['apps/web/page.ts', 'shared.ts']);

    writeFileSync(path.join(dir, 'shared.ts'), 'edited\n');
    expect((await measure(project)).tree).not.toBe(first.tree);
  });

  it('records a sparse checkout, a file outside its cone included', async () => {
    const dir = tempDir();
    initRepo(dir);
    commitFiles(dir, { 'apps/web/page.ts': 'page\n', 'apps/api/server.ts': 'server\n' });
    runGit(dir, 'sparse-checkout', 'set', '--cone', 'apps/web');
    mkdirSync(path.join(dir, 'apps', 'api'), { recursive: true });
    writeFileSync(path.join(dir, 'apps', 'api', 'notes.txt'), 'outside the cone\n');
    const measured = await measure(dir);
    expect(filesIn(dir, measured.tree)).toEqual(['apps/api/notes.txt', 'apps/api/server.ts', 'apps/web/page.ts', 'file.txt']);
  });

  it('reads the record a run wrote, and has none when the file is missing or is not one', async () => {
    const dir = tempDir();
    initRepo(dir);
    const { tree, tracked } = await measure(dir);
    const entry = { testId: 'test', tree, tracked };
    const record = { schemaVersion: 'since-last-run-1', configDigest: DIGEST, settled: { result: entry } };
    writeRecord(dir, JSON.stringify(record));
    expect(await measure(dir)).toMatchObject({ settled: new Map([['result', entry]]), missing: undefined });

    // A pass under another config that shares the output says nothing of this one.
    writeRecord(dir, JSON.stringify({ ...record, configDigest: 'e'.repeat(64) }));
    expect(await measure(dir)).toMatchObject({ settled: new Map(), missing: "the last run's record is of another config" });

    for (const content of [
      'not json',
      JSON.stringify({ ...record, schemaVersion: 'since-last-run-2' }),
      JSON.stringify({ ...record, configDigest: undefined }),
      JSON.stringify({ ...record, settled: ['result'] }),
      JSON.stringify({ ...record, settled: { result: { ...entry, tree: '--help' } } }),
      JSON.stringify({ ...record, settled: { result: { testId: 'test', tree } } }),
      JSON.stringify({ ...record, settled: { result: 'test' } }),
    ]) {
      writeRecord(dir, content);
      expect(await measure(dir)).toMatchObject({ settled: new Map(), missing: "the last run's record is not a since-last-run-1 document" });
    }
  });

  describe('where git cannot record', () => {
    const outside: string[] = [];
    afterEach(() => {
      for (const dir of outside.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it('is SINCE_LAST_RUN_UNAVAILABLE outside a git repository', async () => {
      const dir = mkdtempSync(path.join(realpathSync(os.tmpdir()), 'e2e-no-git-'));
      outside.push(dir);
      await expect(measure(dir)).rejects.toMatchObject({
        code: 'SINCE_LAST_RUN_UNAVAILABLE',
        category: 'configuration',
        message: expect.stringMatching(/^--since-last-run could not record the working tree in a git repository: git rev-parse: not a git repository/u),
      });
    });

    it('says what git refused inside a repository, past a warning it wrote first, and that it ran out of time', async () => {
      const dir = tempDir();
      initRepo(dir);
      mkdirSync(path.join(dir, 'nested'));
      // A nested repository with no commit is one thing `git add` refuses; the line-ending warning for `file.txt` comes before it.
      runGit(path.join(dir, 'nested'), 'init', '--quiet');
      runGit(dir, 'config', 'core.autocrlf', 'true');
      writeFileSync(path.join(dir, 'file.txt'), 'two\n');
      await expect(measure(dir)).rejects.toMatchObject({
        code: 'SINCE_LAST_RUN_UNAVAILABLE',
        message: expect.stringMatching(/^--since-last-run could not record the working tree in a git repository: git add: 'nested\/' does not have a commit checked out/u),
      });
      runGit(dir, 'config', '--unset', 'core.autocrlf');
      rmSync(path.join(dir, 'nested'), { recursive: true });
      await expect(measure(dir, live(), 0)).rejects.toMatchObject({ code: 'SINCE_LAST_RUN_UNAVAILABLE', message: expect.stringContaining('git did not answer within') });
    });

    it('is INTERRUPTED once the run is', async () => {
      const dir = tempDir();
      initRepo(dir);
      const controller = new AbortController();
      controller.abort();
      await expect(measure(dir, controller.signal)).rejects.toMatchObject({ code: 'INTERRUPTED', message: 'interrupted while recording the working tree for --since-last-run' });
    });
  });
});

const idOf = (testId: string, target = 'web') => resultId(testId, target, 'default');
type Trees = Pick<SinceLastRun, 'tree' | 'tracked'>;

/** A record settling each `[testId, trees]`, or `[testId, trees, target]`, as agent `default`, on `web` unless given. */
function settledOf(...entries: readonly (readonly [string, Trees, string?])[]): SettledTests {
  return new Map(entries.map(([testId, { tree, tracked }, target]) => [idOf(testId, target), { testId, tree, tracked }]));
}

const candidate = (id: string): TestFilterCandidate => ({ id, file: 'tests/a.e2e.ts', titlePath: [id], tags: [] });
const pair = (id: string, target = 'web', disposition = 'run'): TestTargetPair => ({ test: { id, kind: 'test' }, target: { name: target }, agent: 'default', disposition }) as unknown as TestTargetPair;
const idsOf = (tests: readonly TestFilterCandidate[]) => tests.map((test) => test.id);

describe('planSinceLastRun', () => {
  /** A repository measured at three states of `src/app.ts`: `older`, then `old`, then `now`, the working tree as it is. */
  async function threeTrees() {
    const dir = tempDir();
    initRepo(dir);
    const states: SinceLastRun[] = [];
    for (const content of ['older\n', 'old\n', 'now\n']) {
      commitFiles(dir, { 'src/app.ts': content });
      states.push(await measure(dir));
    }
    const [older, old, now] = states as [SinceLastRun, SinceLastRun, SinceLastRun];
    const plan = async (ids: readonly string[], pairs: readonly TestTargetPair[], settled: SettledTests) => {
      const { unchanged, judged, changes, owed } = await planSinceLastRun(ids.map(candidate), pairs, { ...now, settled, missing: undefined }, live());
      return { unchanged: idsOf(unchanged), judged: idsOf(judged), base: changes?.base, owed };
    };
    return { older, old, now, plan };
  }

  it('leaves out what passed against the working tree, judges what shares the commonest other tree, and owes the rest a run', async () => {
    const { older, old, now, plan } = await threeTrees();
    const ids = ['same', 'old-1', 'old-2', 'older', 'new'];
    expect(await plan(ids, ids.map((id) => pair(id)), settledOf(['same', now], ['old-1', old], ['old-2', old], ['older', older]))).toEqual({ unchanged: ['same'], judged: ['old-1', 'old-2'], base: old.tracked, owed: 2 });
    // As common as each other: the first tree by code point.
    const first = [old, older].toSorted((a, b) => (a.tree < b.tree ? -1 : 1))[0]!;
    expect(await plan(['old', 'older'], [pair('old'), pair('older')], settledOf(['old', old], ['older', older]))).toEqual({ unchanged: [], judged: [first === old ? 'old' : 'older'], base: first.tracked, owed: 1 });
    expect(await plan(['same'], [pair('same')], settledOf(['same', now]))).toEqual({ unchanged: ['same'], judged: [], base: undefined, owed: 0 });
  });

  it('counts a test by a tree only when every target it runs on settled it against that tree', async () => {
    const { old, now, plan } = await threeTrees();
    const pairs = [pair('both'), pair('both', 'mobile'), pair('one'), pair('one', 'mobile'), pair('split'), pair('split', 'mobile'), pair('skipped'), pair('skipped', 'mobile', 'skip')];
    const settled = settledOf(['both', old], ['both', old, 'mobile'], ['one', old], ['split', old], ['split', now, 'mobile'], ['skipped', old]);
    // A target the selection does not run the test on has no say.
    expect(await plan(['both', 'one', 'split', 'skipped'], pairs, settled)).toEqual({ unchanged: [], judged: ['both', 'skipped'], base: old.tracked, owed: 2 });
  });

  it('hands the filters the change since the tree the judged tests share: every file that differs, and the tracked trees to diff', async () => {
    const dir = tempDir();
    initRepo(dir);
    commitFiles(dir, { 'src/app.ts': 'one\n', 'src/gone.ts': 'gone\n' });
    writeFileSync(path.join(dir, 'notes.txt'), 'untracked before and after\n');
    writeFileSync(path.join(dir, 'local.ts'), 'untracked, then edited\n');
    const first = await measure(dir);

    writeFileSync(path.join(dir, 'src', 'app.ts'), 'two\n');
    runGit(dir, 'commit', '--quiet', '--all', '-m', 'two');
    rmSync(path.join(dir, 'src', 'gone.ts'));
    writeFileSync(path.join(dir, 'added.ts'), 'new\n');
    writeFileSync(path.join(dir, 'local.ts'), 'edited\n');
    const second = await measure(dir);
    const settled = settledOf(['a', first], ['b', second]);
    const plan = await planSinceLastRun(['a', 'b', 'c'].map(candidate), ['a', 'b', 'c'].map((id) => pair(id)), { ...second, settled, missing: undefined }, live());
    expect({ ...plan, unchanged: idsOf(plan.unchanged), judged: idsOf(plan.judged) }).toEqual({
      unchanged: ['b'],
      judged: ['a'],
      owed: 1,
      changes: { base: first.tracked, head: second.tracked, root: realpathSync(dir), files: ['added.ts', 'local.ts', 'src/app.ts', 'src/gone.ts'] },
    });
    expect(Object.isFrozen(plan.changes) && Object.isFrozen(plan.changes?.files)).toBe(true);
    // The trees a filter diffs hold no file that is untracked.
    expect(runGit(dir, 'diff', '--name-only', first.tracked, second.tracked).split('\n')).toEqual(['src/app.ts', 'src/gone.ts']);
  });

  it('owes a run to the tests whose tree git no longer holds, a commit among them, and asks git for nothing when no test is judged', async () => {
    const dir = tempDir();
    const commit = initRepo(dir);
    const measured = await measure(dir);
    const plan = (tree: string) => planSinceLastRun([candidate('a')], [pair('a')], { ...measured, settled: settledOf(['a', { tree, tracked: tree }]), missing: undefined }, live());
    expect(await plan('b'.repeat(40))).toEqual({ unchanged: [], judged: [], changes: undefined, owed: 1 });
    expect(await plan(commit)).toMatchObject({ judged: [expect.objectContaining({ id: 'a' })], owed: 0 });
    expect(await plan(runGit(dir, 'hash-object', '-w', 'file.txt'))).toMatchObject({ judged: [], owed: 1 });
    const aborted = new AbortController();
    aborted.abort();
    expect(await planSinceLastRun([candidate('a')], [pair('a')], { ...measured, settled: new Map(), missing: 'none' }, aborted.signal)).toEqual({ unchanged: [], judged: [], changes: undefined, owed: 1 });
    await expect(planSinceLastRun([candidate('a')], [pair('a')], { ...measured, settled: settledOf(['a', { tree: commit, tracked: commit }]), missing: undefined }, aborted.signal)).rejects.toMatchObject({ code: 'INTERRUPTED' });
  });
});

describe('recordSinceLastRun', () => {
  const HEAD = { tree: 'c'.repeat(40), tracked: 'd'.repeat(40) };
  const OLD = { tree: 'a'.repeat(40), tracked: 'b'.repeat(40) };
  type Row = Record<string, unknown>;
  interface Written {
    readonly schemaVersion: string;
    readonly configDigest: string;
    readonly settled: Record<string, { readonly testId: string; readonly tree: string; readonly tracked: string }>;
  }
  /** A report whose results each name a test by `id`, on `web` as agent `default`, selected, unless a result says otherwise. */
  function report(results: readonly Row[], errors: readonly Row[] = []): Report1Document {
    const rows = results.map((result) => ({ testId: result['id'], kind: 'test', titlePath: [result['id']], file: 'tests/a.e2e.ts', targetId: 'web', agent: 'default', selected: true, attempts: [], ...result }));
    return { schemaVersion: 'report-1', run: { results: rows, errors, serialGroups: [] } } as unknown as Report1Document;
  }
  const measured = (settled?: SettledTests): SinceLastRun => ({ root: '/repo', ...HEAD, configDigest: DIGEST, settled: settled ?? new Map(), missing: settled === undefined ? 'none' : undefined });
  const leftOut = (id: string, skip: Row): Row => ({ id, status: 'skipped', selected: false, skip });
  const read = (recordPath: string) => JSON.parse(readFileSync(recordPath, 'utf8')) as Written;
  /** The tree each test is settled against once a run with the flag reported `results`, by test id; a `[mobile]` suffix for that target. */
  async function after(before: SettledTests | undefined, results: readonly Row[], collected: readonly string[], errors: readonly Row[] = []): Promise<Record<string, string>> {
    const recordPath = path.join(tempDir(), 'since-last-run.json');
    await recordSinceLastRun(recordPath, measured(before), report(results, errors), new Set(collected));
    const names = new Map(['web', 'mobile'].flatMap((target) => collected.map((testId) => [idOf(testId, target), target === 'web' ? testId : `${testId}[${target}]`] as const)));
    return Object.fromEntries(Object.entries(read(recordPath).settled).map(([id, { tree }]) => [names.get(id) ?? id, tree]));
  }

  it('settles a test that passed, a retry included, or skipped itself, against the working tree, and no test that did not', async () => {
    const results = [
      { id: 'passed', status: 'passed' },
      { id: 'flaky', status: 'flaky' },
      { id: 'failed', status: 'failed' },
      { id: 'timed-out', status: 'timed-out' },
      { id: 'interrupted', status: 'interrupted' },
      { id: 'skipped', status: 'skipped', skip: { cause: 'explicit', reason: 'later' } },
      { id: 'unreached', status: 'skipped', skip: { cause: 'failure-limit', reason: 'stopped' } },
      { id: 'setup', kind: 'setup', status: 'passed' },
    ];
    const ids = results.map((result) => result.id);
    expect(await after(undefined, results, ids)).toEqual({ passed: HEAD.tree, flaky: HEAD.tree, skipped: HEAD.tree });
    // One that was settled and did not pass now is settled no more.
    expect(await after(settledOf(...ids.map((id) => [id, OLD] as const)), results, ids)).toEqual({ passed: HEAD.tree, flaky: HEAD.tree, skipped: HEAD.tree, setup: OLD.tree });
  });

  it('moves a settled test a filter left out to the working tree, and keeps the tree of one the run did not select', async () => {
    const before = settledOf(['judged', OLD], ['grepped', OLD], ['absent', OLD], ['other-target', OLD, 'mobile'], ['deleted', OLD]);
    const results = [
      leftOut('judged', { cause: 'filtered', filter: 'decision', reason: '3% likely affected' }),
      leftOut('grepped', { cause: 'filtered', reason: 'title does not match --grep' }),
      // A filter's word settles nothing that was not settled: the run never saw it pass.
      leftOut('unsettled', { cause: 'filtered', filter: 'decision', reason: '3% likely affected' }),
    ];
    expect(await after(before, results, ['judged', 'grepped', 'absent', 'other-target', 'unsettled'])).toEqual({ judged: HEAD.tree, grepped: OLD.tree, absent: OLD.tree, 'other-target[mobile]': OLD.tree });
  });

  it('settles no test a repeat failed, a failed hook covers, or its platform no longer runs', async () => {
    const results = [
      { id: 'repeated', status: 'passed', repeat: 0 },
      { id: 'repeated', status: 'failed', repeat: 1 },
      { id: 'hooked', status: 'passed' },
      { id: 'elsewhere', status: 'passed', file: 'tests/b.e2e.ts' },
      leftOut('off-platform', { cause: 'platform-unavailable', reason: 'web only' }),
    ];
    const hook = { phase: 'afterAll', scope: { file: 'tests/a.e2e.ts', targetId: 'web', titlePath: [] } };
    const ids = ['repeated', 'hooked', 'elsewhere', 'off-platform'];
    expect(await after(settledOf(...ids.map((id) => [id, OLD] as const)), results, ids, [hook])).toEqual({ elsewhere: HEAD.tree });
  });


  it('writes what a run with the flag settled, sorted by result id, as the since-last-run-1 document the schema describes', async () => {
    const recordPath = path.join(tempDir(), 'out', 'since-last-run.json');
    await recordSinceLastRun(recordPath, measured(), report([{ id: 'b', status: 'passed' }, { id: 'a', status: 'passed' }]), new Set(['a', 'b']));
    const written = read(recordPath);
    expect(written).toEqual({ schemaVersion: 'since-last-run-1', configDigest: DIGEST, settled: { [idOf('a')]: { testId: 'a', ...HEAD }, [idOf('b')]: { testId: 'b', ...HEAD } } });
    expect(Object.keys(written.settled)).toEqual([idOf('a'), idOf('b')].toSorted());
    const schema = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', 'schema', 'since-last-run-v1.schema.json'), 'utf8')) as Record<string, unknown>;
    expect(new Ajv2020({ strict: false }).compile(schema)(written)).toBe(true);
  });

  it('takes the tests a run without the flag saw fail or did not reach out of the record, and settles none it saw pass', async () => {
    const recordPath = path.join(tempDir(), 'since-last-run.json');
    const settled = Object.fromEntries(['a', 'b', 'c'].map((id) => [idOf(id), { testId: id, ...OLD }]));
    writeFileSync(recordPath, JSON.stringify({ schemaVersion: 'since-last-run-1', configDigest: DIGEST, settled }));
    const results = [{ id: 'a', status: 'failed' }, { id: 'b', status: 'passed' }, { id: 'c', status: 'skipped', skip: { cause: 'failure-limit', reason: 'stopped' } }, { id: 'd', status: 'passed' }];
    await recordSinceLastRun(recordPath, undefined, report(results), new Set());
    expect(read(recordPath)).toEqual({ schemaVersion: 'since-last-run-1', configDigest: DIGEST, settled: { [idOf('b')]: settled[idOf('b')] } });

    // No record, or nothing it settles failed: no file is written.
    const none = path.join(tempDir(), 'since-last-run.json');
    await recordSinceLastRun(none, undefined, report([{ id: 'a', status: 'failed' }]), new Set());
    expect(() => readFileSync(none)).toThrow();
  });
});
