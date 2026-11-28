/**
 * `--since-last-run`: the change a run's test filters judge is what the
 * working tree gained since each test last passed, whatever git ref the
 * checkout sits on. A run with the flag records the working tree as git
 * tree objects and keeps `<output>/since-last-run.json` (`since-last-run-1`):
 * every test that has passed, with the trees it passed against. The next one
 * leaves out the tests whose tree is still the working tree, hands the
 * filters the tests that share the commonest other tree, and runs the rest
 * unasked. Advisory like the timings history: a file that is not a record is
 * no record, and every test runs.
 */

import { copyFile, mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { E2EError, ConfigurationError, errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { compareCodePoints } from '@e2e-dev/core/lib/internal/globs';
import { resultId } from '@e2e-dev/core/lib/internal/ids';
import { isPlainObject } from '@e2e-dev/core/lib/internal/options';
import { isStrictlyInside, onDiskPath } from '@e2e-dev/core/lib/internal/paths';
import { outputLayout } from '@e2e-dev/core/lib/run/output';
import { skippedItself } from '@e2e-dev/core/lib/run/records';
import type { TestTargetPair } from '../collect/select.ts';
import type { ResolvedRunConfig } from '../config/resolve-run.ts';
import { COMMIT_HASH, filesChanged, GitFailure, gitOutput, repositoryRoot, runGit, withGitBudget, type GitBudgetFailure } from '../internal/git.ts';
import type { Report1Document } from '../report/build.ts';
import { writeJsonReport } from '../report/write.ts';
import type { TestFilterCandidate, TestFilterChanges } from '../run-types.ts';
import { lastFailedIds } from './last-run.ts';

/** The `schemaVersion` of a `since-last-run.json`; the shape is `schema/since-last-run-v1.schema.json`. */
const SCHEMA_VERSION = 'since-last-run-1';

/** Past this a file is not ours to read: a real one holds about 250 bytes a test and target. */
const MAX_RECORD_BYTES = 64 * 1024 * 1024;

/** The most milliseconds recording the working tree may take: it hashes every file that is untracked or edited since the index last saw it. */
const RECORD_BUDGET_MS = 120_000;

/** The most milliseconds measuring the change between two recorded trees may take. */
const CHANGE_BUDGET_MS = 30_000;

/** A working tree as two git tree objects. */
interface WorkingTree {
  /** Every tracked and untracked file git does not ignore, the directories a run writes left out: two working trees hold the same files when this is the same. */
  readonly tree: string;
  /** The tracked files alone, as the working tree has them: what a diff may show the contents of, since an untracked file may hold a secret. */
  readonly tracked: string;
}

/** One settled test on one target and agent: its test id, and the working tree it last passed against or was last judged unaffected up to. */
interface Settled extends WorkingTree {
  readonly testId: string;
}

/** The settled tests by result id (test, target, and agent). */
export type SettledTests = ReadonlyMap<string, Settled>;

/** What a `since-last-run.json` holds: the tests a config's runs settled. */
interface LastRunRecord {
  /** The digest of the config whose runs settled the tests: a pass under one config says nothing of another that shares its output. */
  readonly configDigest: string;
  readonly settled: SettledTests;
}

/** What a `--since-last-run` run measured before its filters decide: the working tree as it found it, and the last run's record. */
export interface SinceLastRun extends WorkingTree, LastRunRecord {
  /** Absolute path of the git repository root, spelled as on disk. */
  readonly root: string;
  /** The tests the last run's record settled; none without a record of this config. */
  readonly settled: SettledTests;
  /** Why there is no record to measure from, as a notice says it; undefined with one. */
  readonly missing: string | undefined;
}

/**
 * Records the working tree and reads the last run's record, for the project
 * of `config`. A project outside a git repository, or a working tree git
 * cannot record in `budgetMs` (2 minutes unless given) or at all, is
 * `SINCE_LAST_RUN_UNAVAILABLE`; an abort of `interrupt` is `INTERRUPTED`.
 */
export function measureSinceLastRun(config: Pick<ResolvedRunConfig, 'projectRoot' | 'output' | 'cache' | 'configDigest'>, interrupt: AbortSignal, budgetMs = RECORD_BUDGET_MS): Promise<SinceLastRun> {
  return withGitBudget(
    interrupt,
    budgetMs,
    async (signal) => {
      const root = await repositoryRoot(onDiskPath(config.projectRoot), signal);
      // What one run wrote under the output and the cache is no change for the next to judge.
      const [trees, record] = await Promise.all([recordWorkingTree(root, [config.output, config.cache.dir], signal), readRecord(outputLayout(config.output).sinceLastRun)]);
      const { configDigest } = config;
      if ('missing' in record) return { root: onDiskPath(root), ...trees, configDigest, settled: new Map(), missing: record.missing };
      const other = record.configDigest === configDigest ? undefined : "the last run's record is of another config";
      return { root: onDiskPath(root), ...trees, configDigest, settled: other === undefined ? record.settled : new Map(), missing: other };
    },
    unavailable('recording the working tree for --since-last-run', '--since-last-run could not record the working tree in a git repository'),
  );
}

/** How a git failure under `--since-last-run` reads: `INTERRUPTED` while `doing`, else `SINCE_LAST_RUN_UNAVAILABLE` saying `what` and why. */
function unavailable(doing: string, what: string): (failed: GitBudgetFailure) => Error {
  return (failed) =>
    failed.kind === 'interrupted'
      ? new E2EError('interrupted', 'INTERRUPTED', `interrupted while ${doing}`)
      : new ConfigurationError('SINCE_LAST_RUN_UNAVAILABLE', `${what}: ${failed.why}`, { cause: failed.cause });
}

/**
 * Writes the working tree as two tree objects without touching the
 * checkout's index: a copy of the index, so unchanged files are not hashed
 * again, takes the tracked files as they are, then every untracked file git
 * does not ignore, with nothing under `written` in either. The objects are
 * unreferenced, as a `git stash create` commit is, so `git gc` prunes them
 * once they are older than `gc.pruneExpire`, two weeks by default.
 */
async function recordWorkingTree(root: string, written: readonly string[], signal: AbortSignal): Promise<WorkingTree> {
  const index = path.resolve(root, (await gitOutput(root, ['rev-parse', '--git-path', 'index'], signal)).replace(/\r?\n$/u, ''));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'e2e-since-last-run-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
    await copyIndex(index, env.GIT_INDEX_FILE);
    const repository = onDiskPath(root);
    const leftOut = written.map(onDiskPath).filter((directory) => isStrictlyInside(repository, directory)).map((directory) => path.relative(repository, directory).split(path.sep).join('/'));
    const everything = ['--', '.', ...leftOut.map((directory) => `:(exclude,literal)${directory}`)];
    const writeTree = async (): Promise<string> => {
      const tree = (await gitOutput(root, ['write-tree'], signal, env)).trim();
      if (!COMMIT_HASH.test(tree)) throw new GitFailure('git write-tree printed no tree');
      return tree;
    };
    // A sparse checkout refuses a path outside its cone without `--sparse`, which git older than 2.34 does not know.
    const sparse = (await runGit(root, ['config', '--type=bool', '--get', 'core.sparseCheckout'], { signal })).stdout.trim() === 'true' ? ['--sparse'] : [];
    // A file under `written` that is committed came with the index: it leaves the trees too.
    if (leftOut.length > 0) await gitOutput(root, ['--literal-pathspecs', 'rm', '-r', '--cached', '--quiet', '--ignore-unmatch', ...sparse, '--', ...leftOut], signal, env);
    await gitOutput(root, ['add', '--update', ...sparse], signal, env);
    const tracked = await writeTree();
    await gitOutput(root, ['add', '--all', ...sparse, ...everything], signal, env);
    return { tree: await writeTree(), tracked };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Whether `cause` says a file is not there. */
function isMissingFile(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Copies the checkout's index to `to`, keeping its modification time, whole
 * seconds down. Git hashes a file again only when the file is as new as the
 * index that lists it, so a copy stamped now would trust the size and time
 * of a file edited in the second the real index was written, and miss the
 * edit. A repository with nothing staged yet has no index: `to` is left
 * absent and git starts an empty one.
 */
async function copyIndex(from: string, to: string): Promise<void> {
  try {
    const { mtimeMs } = await stat(from);
    await copyFile(from, to);
    const seconds = Math.floor(mtimeMs / 1000);
    await utimes(to, seconds, seconds);
  } catch (cause) {
    if (!isMissingFile(cause)) throw cause;
  }
}

/** The record at `recordPath`, or why there is none to measure from. */
async function readRecord(recordPath: string): Promise<LastRunRecord | { readonly missing: string }> {
  let text: string;
  try {
    if ((await stat(recordPath)).size > MAX_RECORD_BYTES) return { missing: "the last run's record is too large to be one" };
    text = await readFile(recordPath, 'utf8');
  } catch (cause) {
    return { missing: isMissingFile(cause) ? 'no run has recorded the working tree yet' : `the last run's record could not be read (${errorMessage(cause)})` };
  }
  try {
    const document: unknown = JSON.parse(text);
    if (isPlainObject(document) && document.schemaVersion === SCHEMA_VERSION && typeof document.configDigest === 'string' && isPlainObject(document.settled)) {
      const settled = Object.entries(document.settled).filter((entry): entry is [string, Settled] => isSettled(entry[1]));
      if (settled.length === Object.keys(document.settled).length) return { configDigest: document.configDigest, settled: new Map(settled) };
    }
  } catch {
    // Not JSON: no record, as below.
  }
  return { missing: `the last run's record is not a ${SCHEMA_VERSION} document` };
}

function isSettled(value: unknown): value is Settled {
  const isTree = (tree: unknown): boolean => typeof tree === 'string' && COMMIT_HASH.test(tree);
  return isPlainObject(value) && typeof value.testId === 'string' && isTree(value.tree) && isTree(value.tracked);
}

/**
 * How a `--since-last-run` run treats the tests its selection runs:
 * `unchanged` have passed against the working tree as it is and are left
 * out; the filters judge `judged` against `changes`; `owed` is how many of
 * the rest run unasked.
 */
export interface LastRunPlan {
  readonly unchanged: readonly TestFilterCandidate[];
  readonly judged: readonly TestFilterCandidate[];
  /** The change since the tree `judged` share; undefined when no test is judged. */
  readonly changes: TestFilterChanges | undefined;
  readonly owed: number;
}

/**
 * Plans `candidates`, the tests the selection's `pairs` run, from what
 * `measured` found. The filters are called once, so they judge the tests
 * that last passed against the commonest tree other than the working tree,
 * against the change since it. A test runs unasked when it did not pass, is
 * new, last passed against another tree, or against one git has pruned
 * since.
 */
export async function planSinceLastRun(candidates: readonly TestFilterCandidate[], pairs: readonly TestTargetPair[], measured: SinceLastRun, interrupt: AbortSignal): Promise<LastRunPlan> {
  const split = splitByTree(candidates, pairs, measured.settled, measured.tree);
  const changes = split.base === undefined ? undefined : await changesSince(measured, split.base, interrupt);
  const judged = changes === undefined ? [] : split.judged;
  return { unchanged: split.unchanged, judged, changes, owed: candidates.length - split.unchanged.length - judged.length };
}

/**
 * Splits `candidates` by the tree the record settled each against:
 * `unchanged` against `tree`, the working tree as it is, and `judged`
 * against `base`, the commonest other one; two as common as each other, the
 * first by code point. A test counts by a tree only when every target and
 * agent `pairs` runs it on settled it against that tree, since a filter
 * leaves a test out whole.
 */
function splitByTree(
  candidates: readonly TestFilterCandidate[],
  pairs: readonly TestTargetPair[],
  settled: SettledTests,
  tree: string,
): { readonly unchanged: readonly TestFilterCandidate[]; readonly judged: readonly TestFilterCandidate[]; readonly base: WorkingTree | undefined } {
  const passed = new Map<string, Settled | undefined>();
  for (const { test, target, agent, disposition } of pairs) {
    if (test.kind !== 'test' || disposition !== 'run') continue;
    const entry = settled.get(resultId(test.id, target.name, agent));
    passed.set(test.id, passed.has(test.id) && passed.get(test.id)?.tree !== entry?.tree ? undefined : entry);
  }
  const others = new Map<string, { readonly base: WorkingTree; tests: number }>();
  for (const entry of passed.values()) {
    if (entry === undefined || entry.tree === tree) continue;
    const other = others.get(entry.tree) ?? { base: { tree: entry.tree, tracked: entry.tracked }, tests: 0 };
    other.tests += 1;
    others.set(entry.tree, other);
  }
  const base = [...others.values()].toSorted((a, b) => b.tests - a.tests || compareCodePoints(a.base.tree, b.base.tree))[0]?.base;
  const against = (wanted: string | undefined) => (wanted === undefined ? [] : candidates.filter((candidate) => passed.get(candidate.id)?.tree === wanted));
  return { unchanged: against(tree), judged: against(base?.tree), base };
}

/**
 * The change from the working tree `base` to the one `measured` found, as
 * the filters take it: every file that differs, sorted, and the tracked
 * trees to diff, so a filter reads no contents of a file that was untracked
 * at either end. Undefined when git no longer holds `base`, which it prunes
 * once unreferenced for two weeks. Every git call together has 30 seconds.
 */
function changesSince(measured: SinceLastRun, base: WorkingTree, interrupt: AbortSignal): Promise<TestFilterChanges | undefined> {
  return withGitBudget(
    interrupt,
    CHANGE_BUDGET_MS,
    async (signal) => {
      const held = await Promise.all([base.tree, base.tracked].map((tree) => runGit(measured.root, ['cat-file', '-e', `${tree}^{tree}`], { signal })));
      if (held.some((result) => result.exitCode !== 0)) return undefined;
      const files = (await filesChanged(measured.root, base.tree, signal, measured.tree)).toSorted(compareCodePoints);
      return Object.freeze({ base: base.tracked, head: measured.tracked, root: measured.root, files: Object.freeze(files) });
    },
    unavailable('finding the change since the last run', '--since-last-run could not measure the change since the last run'),
  );
}

/** The result ids of the tests `document` ran that are owed another run: one that did not pass on every repeat, or that a failed hook covers. A test that skipped itself is owed none. */
function owedIds(document: Report1Document): ReadonlySet<string> {
  const owed = new Set(lastFailedIds(document));
  for (const result of document.run.results) {
    if (result.kind !== 'test' || result.selected === false || result.status === 'passed' || result.status === 'flaky') continue;
    if (result.status !== 'skipped' || !skippedItself(result.skip?.cause)) owed.add(resultId(result.testId, result.targetId, result.agent));
  }
  return owed;
}

/**
 * The settled tests a run that `measured` leaves for the next. A test the
 * run selected and owes no other run is settled against the working tree it
 * recorded, and so is one settled before that a filter left out: nothing
 * changed for it, or the filters judged the change cannot affect it. One the
 * run did not select keeps the trees it had, so a run narrowed past it, as
 * by `--grep`, leaves it measured from where it last passed. One the run
 * owes a run, that no longer runs on its target's platform, or that
 * collection no longer finds (`collected`, by test id) is settled no more.
 */
function settledAfter(measured: SinceLastRun, document: Report1Document, collected: ReadonlySet<string>): SettledTests {
  const settled = new Map([...measured.settled].filter(([, { testId }]) => collected.has(testId)));
  const here = { tree: measured.tree, tracked: measured.tracked };
  for (const result of document.run.results) {
    if (result.kind !== 'test') continue;
    const id = resultId(result.testId, result.targetId, result.agent);
    if (result.selected !== false || (result.skip?.filter !== undefined && settled.has(id))) settled.set(id, { testId: result.testId, ...here });
    else if (result.skip?.cause === 'platform-unavailable') settled.delete(id);
  }
  for (const id of owedIds(document)) settled.delete(id);
  return settled;
}

/**
 * Keeps `<output>/since-last-run.json` (`recordPath`) in step with a run's
 * report. A run with the flag (`measured`) writes what `settledAfter` leaves.
 * A run without it only takes out of an existing record the tests it owes a
 * run, the ones it did not reach among them, so the next run with the flag
 * does not leave out a test this one saw fail. Like the timings history the record only narrows a later run, so a
 * failed write is said on stderr and fails nothing.
 */
export async function recordSinceLastRun(recordPath: string, measured: SinceLastRun | undefined, document: Report1Document, collected: ReadonlySet<string>): Promise<void> {
  try {
    if (measured !== undefined) return await writeRecord(recordPath, { configDigest: measured.configDigest, settled: settledAfter(measured, document, collected) });
    const record = await readRecord(recordPath);
    if ('missing' in record) return;
    const owed = [...owedIds(document)].filter((id) => record.settled.has(id));
    if (owed.length === 0) return;
    const settled = new Map(record.settled);
    for (const id of owed) settled.delete(id);
    await writeRecord(recordPath, { ...record, settled });
  } catch (cause) {
    process.stderr.write(`e2e: the --since-last-run record could not be written: ${errorMessage(cause)}\n`);
  }
}

/** Writes `record` as a `since-last-run-1` document, its entries sorted by result id. */
async function writeRecord(recordPath: string, record: LastRunRecord): Promise<void> {
  const entries = [...record.settled].toSorted(([a], [b]) => compareCodePoints(a, b));
  await writeJsonReport(recordPath, { schemaVersion: SCHEMA_VERSION, configDigest: record.configDigest, settled: Object.fromEntries(entries) });
}
