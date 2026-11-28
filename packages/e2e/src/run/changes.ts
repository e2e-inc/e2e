/**
 * The change a run's test filters judge with `--changed-since <ref>`:
 * every file that differs from where HEAD branched off the ref, in the
 * working tree, untracked files included. A ref git cannot measure from is
 * `INVALID_CHANGED_SINCE`.
 */

import { describeValue } from '@e2e-dev/core/lib/config/validate';
import { ConfigurationError, E2EError } from '@e2e-dev/core/lib/internal/errors';
import { COMMIT_HASH, filesChanged, GIT_MAX_BUFFER, GitFailure, gitFailureText, gitOutput, repositoryRoot, runGit, withGitBudget } from '../internal/git.ts';
import { compareCodePoints } from '@e2e-dev/core/lib/internal/globs';
import { onDiskPath } from '@e2e-dev/core/lib/internal/paths';
import type { TestFilterChanges } from '../run-types.ts';

/**
 * A `changedSince` that is not a string, is empty, or reads as a git option
 * is `INVALID_CHANGED_SINCE` before git is asked.
 */
export function validateChangedSince(ref: unknown): void {
  if (ref !== undefined && typeof ref !== 'string') {
    throw new ConfigurationError('INVALID_CHANGED_SINCE', `--changed-since must name a git ref, such as origin/main; got ${describeValue(ref)}`);
  }
  if (ref !== undefined && (ref === '' || ref.startsWith('-'))) {
    throw new ConfigurationError('INVALID_CHANGED_SINCE', `--changed-since must name a git ref, such as origin/main; got ${JSON.stringify(ref)}`);
  }
}

/** What `findChanges` asks git from, and when it gives up. */
interface ChangeOptions {
  /** The directory git is asked in: the project root. */
  readonly cwd: string;
  /** The base ref `--changed-since` named. */
  readonly changedSince: string;
  /** The run's interrupt: aborting it rejects with `INTERRUPTED`. */
  readonly signal: AbortSignal;
  /** The most milliseconds every git call together may take; default 30000. */
  readonly budgetMs?: number;
  /** What the change is for, as an interrupt names it; default `the change the test filters judge`. */
  readonly purpose?: string;
}

const GIT_BUDGET_MS = 30_000;

/**
 * Finds the change the test filters judge: every file that differs from
 * the merge base of `changedSince` and HEAD, in the working tree, untracked
 * files included, sorted; `files` is empty when nothing changed. Every git
 * call together has a 30 second budget; a ref git cannot measure from, in
 * time or at all, is `INVALID_CHANGED_SINCE`.
 */
export function findChanges(options: ChangeOptions): Promise<TestFilterChanges> {
  const ref = options.changedSince;
  return withGitBudget(options.signal, options.budgetMs ?? GIT_BUDGET_MS, (signal) => lookUp(ref, options.cwd, signal), (failed) =>
    failed.kind === 'interrupted'
      ? new E2EError('interrupted', 'INTERRUPTED', `interrupted while finding ${options.purpose ?? 'the change the test filters judge'}`)
      : invalidChangedSince(`--changed-since ${JSON.stringify(ref)}: ${failed.why}`, failed.cause),
  );
}

/** The change since `ref`, asking git within `signal`. */
async function lookUp(ref: string, cwd: string, signal: AbortSignal): Promise<TestFilterChanges> {
  const root = await repositoryRoot(cwd, signal);
  const quoted = JSON.stringify(ref);
  const commit = await commitOf(root, ref, signal);
  if (commit === undefined) throw invalidChangedSince(`--changed-since ${quoted} names no commit in this checkout; fetch it, such as with fetch-depth: 0 on actions/checkout or GIT_DEPTH: 0 on GitLab`);
  const base = await mergeBase(root, commit, signal);
  if (base === undefined) {
    throw invalidChangedSince(
      (await isShallow(root, signal))
        ? `--changed-since ${quoted} shares no history with HEAD in this checkout; fetch more history, such as git fetch --unshallow`
        : `--changed-since ${quoted} shares no history with HEAD: their histories are unrelated; name a ref on the history of HEAD`,
    );
  }
  return changesSince(root, base, signal);
}

/**
 * Every file in the working tree that differs from `base`, staged or not,
 * and the untracked files, sorted by code point. An untracked nested
 * repository, which git lists as its directory, is not this repository's
 * change.
 */
async function changesSince(root: string, base: string, signal: AbortSignal): Promise<TestFilterChanges> {
  const [tracked, untracked] = await Promise.all([
    filesChanged(root, base, signal),
    gitOutput(root, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'], signal),
  ]);
  const files = [...new Set([...tracked, ...untracked.split('\0').filter((file) => file !== '' && !file.endsWith('/'))])].toSorted(compareCodePoints);
  // As on disk, like the filter context's `projectRoot`: git prints `C:/repo` on Windows.
  return Object.freeze({ base, root: onDiskPath(root), files: Object.freeze(files) });
}

/**
 * The commit `rev` names in the checkout, or undefined when it names none
 * here. The object is found first and peeled after, so a rev whose syntax
 * takes the rest of the text, as `:/message` does, is not handed `^{commit}`.
 */
async function commitOf(root: string, rev: string, signal: AbortSignal): Promise<string | undefined> {
  const found = await runGit(root, ['rev-parse', '--verify', '--quiet', rev], { signal, maxBuffer: GIT_MAX_BUFFER });
  const object = found.stdout.trim();
  if (found.exitCode !== 0 || !COMMIT_HASH.test(object)) return undefined;
  const peeled = await runGit(root, ['rev-parse', '--verify', '--quiet', `${object}^{commit}`], { signal, maxBuffer: GIT_MAX_BUFFER });
  const commit = peeled.stdout.trim();
  return peeled.exitCode === 0 && COMMIT_HASH.test(commit) ? commit : undefined;
}

/** The merge base of `commit` and HEAD, or undefined when the checkout holds no shared history. */
async function mergeBase(root: string, commit: string, signal: AbortSignal): Promise<string | undefined> {
  const result = await runGit(root, ['merge-base', commit, 'HEAD'], { signal, maxBuffer: GIT_MAX_BUFFER });
  if (result.exitCode === 1) return undefined;
  if (result.exitCode !== 0) throw new GitFailure(gitFailureText(['merge-base'], result));
  const base = result.stdout.trim();
  return COMMIT_HASH.test(base) ? base : undefined;
}

/** Whether the checkout is shallow, so a missing merge base may be history it has not fetched. */
async function isShallow(root: string, signal: AbortSignal): Promise<boolean> {
  return (await gitOutput(root, ['rev-parse', '--is-shallow-repository'], signal)).trim() === 'true';
}

/** `--changed-since` named something git cannot measure a change from. */
function invalidChangedSince(message: string, cause?: unknown): ConfigurationError {
  return new ConfigurationError('INVALID_CHANGED_SINCE', message, cause === undefined ? {} : { cause });
}
