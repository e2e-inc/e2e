/**
 * The one way the runner asks git a question. `runGit` answers whatever git
 * exits with and says why when git could not answer, for a caller that fails
 * on it. `git` is best-effort by design: git may be missing, slow, or outside
 * a repository, and none of that fails a run.
 */

import { execFile } from 'node:child_process';
import { E2EError } from '@e2e-dev/core/lib/internal/errors';
import { budgetText } from '@e2e-dev/core/lib/internal/time';

/** A full SHA-1 or SHA-256 object name. */
// Full Git SHA-1 and SHA-256 object IDs are exactly 40 and 64 digits;
// intermediate lengths are neither full format and must not certify provenance.
export const COMMIT_HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** One git call's exit code and output. */
export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** How long one git call may run, and how much it may print. */
interface GitOptions {
  /** Aborting it kills git and rejects with the abort. */
  readonly signal?: AbortSignal;
  /** The most bytes git may print on stdout or stderr; default 1 MiB. */
  readonly maxBuffer?: number;
  /** Variables set over the process environment for this call, such as `GIT_INDEX_FILE`. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** Git could not answer: it is missing, printed too much, or failed outright. The message says which. */
export class GitFailure extends Error {}

/**
 * Runs git once in `cwd`: its exit code and output, whatever the code. Git
 * that is missing or prints past `maxBuffer` is a `GitFailure`; an abort
 * rejects with the abort, and the caller reads its signal for why.
 */
export function runGit(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const { signal, maxBuffer = 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, signal, maxBuffer, windowsHide: true, encoding: 'utf8', env: { ...process.env, ...options.env } }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout, stderr });
        return;
      }
      if (typeof error.code === 'number') {
        resolve({ exitCode: error.code, stdout, stderr });
        return;
      }
      if (signal?.aborted) reject(error);
      else if (error.code === 'ENOENT') reject(new GitFailure('git was not found'));
      else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new GitFailure(`git ${args[0] ?? ''} printed more than ${maxBuffer / 1024 / 1024} MiB`));
      else reject(new GitFailure(`git ${args[0] ?? ''}: ${error.message}`));
    });
  });
}

/** One git command's trimmed stdout; undefined when git is missing, slow, or refuses. */
export async function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await runGit(cwd, args, { signal: AbortSignal.timeout(1_000) });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** How much one git call that lists files may print: a diff's file list on a large monorepo runs to megabytes. */
export const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** A git call's stdout, under `env` when set; a non-zero exit is a `GitFailure` quoting what git said. */
export async function gitOutput(cwd: string, args: readonly string[], signal: AbortSignal, env?: Readonly<Record<string, string>>): Promise<string> {
  const result = await runGit(cwd, args, { signal, maxBuffer: GIT_MAX_BUFFER, env });
  if (result.exitCode !== 0) throw new GitFailure(gitFailureText(args, result));
  return result.stdout;
}

/**
 * `git rev-parse: not a git repository`: the command and what git said went
 * wrong, without its `fatal:` prefix and cut to 200 code points. That is the
 * first line git marked `fatal:` or `error:`, since a warning may come before
 * it, else the first line it wrote.
 */
export function gitFailureText(args: readonly string[], result: GitResult): string {
  const lines = result.stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const said = [...(lines.find((line) => /^(fatal|error): /u.test(line)) ?? lines[0] ?? `exited with code ${result.exitCode}`).replace(/^(fatal|error): /u, '')];
  return `git ${args[0] ?? ''}: ${said.length <= 200 ? said.join('') : `${said.slice(0, 199).join('')}…`}`;
}

/** The repository `cwd` is in, by its absolute root. */
export async function repositoryRoot(cwd: string, signal: AbortSignal): Promise<string> {
  const root = (await gitOutput(cwd, ['rev-parse', '--show-toplevel'], signal)).replace(/\r?\n$/u, '');
  if (root === '') throw new GitFailure('git rev-parse --show-toplevel printed no repository root');
  return root;
}

/** Every file that differs between `base` and `head`, or between `base` and the tracked files of the working tree without `head`, both paths of a rename, as git prints them. */
export async function filesChanged(root: string, base: string, signal: AbortSignal, head?: string): Promise<string[]> {
  const diff = await gitOutput(root, ['diff', '--name-only', '--no-renames', '--no-ext-diff', '-z', base, ...(head === undefined ? [] : [head]), '--'], signal);
  return diff.split('\0').filter((file) => file !== '');
}

/** Why `withGitBudget` gave up: the run was interrupted, or git did not answer in time or at all. */
export type GitBudgetFailure = { readonly kind: 'interrupted' } | { readonly kind: 'failed'; readonly why: string; readonly cause: unknown };

/**
 * Runs `work`, every git call of which takes its signal, within `budgetMs`
 * and the caller's `interrupt`. An `E2EError` that `work` throws stands;
 * anything else is rethrown as `failure` makes it: `interrupted` once
 * `interrupt` aborted, else `failed` with the reason, which is the budget
 * once it ran out.
 */
export async function withGitBudget<T>(interrupt: AbortSignal, budgetMs: number, work: (signal: AbortSignal) => Promise<T>, failure: (failed: GitBudgetFailure) => Error): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), budgetMs);
  try {
    return await work(AbortSignal.any([interrupt, deadline.signal]));
  } catch (cause) {
    if (interrupt.aborted) throw failure({ kind: 'interrupted' });
    if (cause instanceof E2EError) throw cause;
    const why = deadline.signal.aborted ? `git did not answer within ${budgetText(budgetMs)}` : cause instanceof GitFailure ? cause.message : String(cause);
    throw failure({ kind: 'failed', why, cause });
  } finally {
    clearTimeout(timer);
  }
}
