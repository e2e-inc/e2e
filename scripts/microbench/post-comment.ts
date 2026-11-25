/**
 * Posts the `microbench` workflow's results to its pull request as one
 * comment, and edits that comment on every later run
 * (`.github/workflows/microbench.yml`, job `comment`).
 *
 *   node scripts/microbench/post-comment.ts <dir> [--dry-run]
 *
 * `<dir>` holds the downloaded artifacts, `microbench-compare/result.json`
 * and `microbench-repeatability/result.json`; a job that did not finish
 * leaves its file out, and the comment says so. Reads the pull request number
 * from the event at `GITHUB_EVENT_PATH` and posts with `GITHUB_TOKEN` against
 * `GITHUB_REPOSITORY`. `--dry-run` prints the comment and posts nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setMarkerComment } from '../review-label/github.ts';
import { COMMENT_MARKER, renderComment } from './comment.ts';
import type { Result } from './markdown.ts';

const { GITHUB_EVENT_PATH: eventPath, GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = process.env;
const dir = process.argv[2];
if (dir === undefined || !eventPath || !server || !repo || !runId) {
  process.stderr.write('usage: post-comment.ts <dir> [--dry-run], with GITHUB_EVENT_PATH, GITHUB_SERVER_URL, GITHUB_REPOSITORY, and GITHUB_RUN_ID set\n');
  process.exit(2);
}

/** A job's `result.json` under `root`, or undefined when the job wrote none. */
function read(root: string, artifact: string): Result | undefined {
  const file = path.join(root, artifact, 'result.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Result) : undefined;
}

const body = renderComment({
  compare: read(dir, 'microbench-compare'),
  repeatability: read(dir, 'microbench-repeatability'),
  runUrl: `${server}/${repo}/actions/runs/${runId}`,
});
if (process.argv.includes('--dry-run')) {
  process.stdout.write(body);
} else {
  const { number } = (JSON.parse(readFileSync(eventPath, 'utf8')) as { pull_request: { number: number } }).pull_request;
  await setMarkerComment(number, COMMENT_MARKER, body);
}
