/**
 * The arithmetic of `scripts/microbench.ts`: reading a Cachegrind total,
 * turning two process totals into a per-iteration cost, and judging a
 * base/head comparison.
 */

import { median } from '../bench-ab/stats.ts';

/** What a measured process reports: instructions under Cachegrind, nanoseconds of the loop without it. */
export type Tool = 'cachegrind' | 'time';

/** One process: the measured loop's iteration count and the tool's total. */
export interface Measurement {
  readonly iterations: number;
  readonly total: number;
}

export interface TrialSpread {
  readonly median: number;
  readonly min: number;
  readonly max: number;
  /** `(max - min) / median`, in percent: how far apart the trials of one checkout land. */
  readonly spreadPercent: number;
}

export type Direction = 'lower' | 'higher' | 'same' | 'inconclusive';

export interface Assessment {
  /** Head median over base median, minus one, in percent. */
  readonly changePercent: number;
  readonly verdict: Direction;
  /** Why the verdict is what it is, for the summary. */
  readonly reason: string;
}

/**
 * The instruction count a Cachegrind output file totals: its `summary:`
 * line, whose first number is `Ir` (the only event without cache simulation).
 */
export function cachegrindTotal(text: string): number {
  const line = /^summary:\s+(\d+)/m.exec(text);
  if (line?.[1] === undefined) throw new Error('no summary line in the Cachegrind output');
  const total = Number(line[1]);
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error(`bad Cachegrind total: ${line[1]}`);
  return total;
}

/**
 * The cost of one more iteration: the difference of two processes that ran
 * the same case `low.iterations` and `high.iterations` times. Startup,
 * loading, warmup, compilation, and the code around the loop are in both
 * totals and cancel, leaving the steady-state loop. A slope at or below zero
 * means the larger run did less work, which is a broken measurement.
 */
export function slope(low: Measurement, high: Measurement): number {
  if (high.iterations <= low.iterations) throw new Error('the high run must have more iterations than the low run');
  const value = (high.total - low.total) / (high.iterations - low.iterations);
  if (!(value > 0)) throw new Error(`non-positive slope (${low.total} at ${low.iterations}, ${high.total} at ${high.iterations})`);
  return value;
}

export function spreadOf(values: readonly number[]): TrialSpread {
  if (values.length === 0) throw new Error('no trials');
  const mid = median(values);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { median: mid, min, max, spreadPercent: ((max - min) / mid) * 100 };
}

/**
 * Judges head against base from one value per trial on each side.
 *
 * Instruction counts: a direction only when the two sides' trial ranges do
 * not overlap, else inconclusive. Repeatable counts make this strict rule
 * cheap, and it never reports a change the trials themselves contradict.
 *
 * Wall time: the trials are paired by round (each round ran base and head
 * back to back, in alternating order), and a direction needs every round to
 * agree on it and the median paired change to reach `thresholdPercent`;
 * otherwise `same` when it stays under the threshold, else inconclusive.
 */
export function assess(tool: Tool, base: readonly number[], head: readonly number[], thresholdPercent: number): Assessment {
  if (base.length === 0 || base.length !== head.length) throw new Error('base and head need the same number of trials');
  const changePercent = (median(head) / median(base) - 1) * 100;
  if (tool === 'cachegrind') {
    const b = spreadOf(base);
    const h = spreadOf(head);
    if (b.min <= h.max && h.min <= b.max) return { changePercent, verdict: 'inconclusive', reason: 'ranges overlap' };
    return { changePercent, verdict: h.median < b.median ? 'lower' : 'higher', reason: 'ranges do not overlap' };
  }
  const paired = base.map((value, round) => ((head[round] as number) / value - 1) * 100);
  const change = median(paired);
  const agree = paired.every((value) => value < 0) || paired.every((value) => value > 0);
  if (agree && Math.abs(change) >= thresholdPercent) {
    return { changePercent: change, verdict: change < 0 ? 'lower' : 'higher', reason: `every round agrees, median ${format(change)}` };
  }
  if (Math.abs(change) < thresholdPercent) {
    return { changePercent: change, verdict: 'same', reason: `median paired change under ${thresholdPercent}%` };
  }
  return { changePercent: change, verdict: 'inconclusive', reason: 'rounds disagree on direction' };
}

/** A signed percentage with at most three decimals. */
export function format(percent: number): string {
  const rounded = Math.round(percent * 1000) / 1000;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}
