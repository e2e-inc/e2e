/**
 * The pull request comment the `microbench` workflow keeps current: the
 * `compare` job's table under a one-line headline, and whether the
 * `repeatability` job found the counts stable enough to trust it.
 */

import { comparisonLines, methodLines, repeatabilityFailures, type Result } from './markdown.ts';

/** The first line of the workflow's comment; the run edits the comment that carries it. */
export const COMMENT_MARKER = '<!-- microbench -->';

export interface CommentInput {
  /** The `compare` job's `result.json`, or undefined when the job left none. */
  readonly compare: Result | undefined;
  /** The `repeatability` job's `result.json`, or undefined when the job left none. */
  readonly repeatability: Result | undefined;
  readonly runUrl: string;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the comparison says, in one line. */
function headline(compare: Result | undefined, runUrl: string): string {
  if (compare === undefined) return `⚠️ The comparison did not finish. See the [workflow run](${runUrl}).`;
  const verdicts = compare.rows.map((row) => row.assessment?.verdict);
  const higher = verdicts.filter((verdict) => verdict === 'higher').length;
  const lower = verdicts.filter((verdict) => verdict === 'lower').length;
  if (higher === 0 && lower === 0) return `⚪ No case changed by ${compare.thresholdPercent}% or more.`;
  return [
    ...(higher > 0 ? [`🔴 ${plural(higher, 'case costs', 'cases cost')} more`] : []),
    ...(lower > 0 ? [`🟢 ${plural(lower, 'case costs', 'cases cost')} less`] : []),
  ].join(', ').concat('.');
}

/** Whether two builds of the head agreed, which is what makes the comparison worth reading. */
function repeatabilityLine(repeatability: Result | undefined): string {
  if (repeatability === undefined) return '⚠️ The repeatability check did not finish, so these counts are not known to be stable.';
  const failures = repeatabilityFailures(repeatability);
  if (failures.length === 0) return `Repeatability: two builds of the head agree in every case, ${repeatability.trials} trials each.`;
  const cases = failures.map((row) => `\`${row.case}\` (${row.mode})`).join(', ');
  return `⚠️ Repeatability check failed: two builds of the head landed apart in ${cases}. A direction below can be measurement noise.`;
}

/** The whole comment body, opening with {@link COMMENT_MARKER}. */
export function renderComment({ compare, repeatability, runUrl }: CommentInput): string {
  return [
    COMMENT_MARKER,
    '### Microbenchmarks',
    '',
    headline(compare, runUrl),
    '',
    repeatabilityLine(repeatability),
    '',
    ...(compare === undefined
      ? []
      : [...comparisonLines(compare), '<details><summary>How this is measured</summary>', '', ...methodLines(compare), '</details>', '']),
    `[Workflow run](${runUrl}): each job's summary, and \`result.json\` in its artifact.`,
    '',
  ].join('\n');
}
