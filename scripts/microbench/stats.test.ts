import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderSummary, repeatabilityFailures, type Result } from './markdown.ts';
import { assess, cachegrindTotal, format, slope, spreadOf } from './stats.ts';

describe('cachegrindTotal', () => {
  it('reads the summary line of a Cachegrind output file', () => {
    const text = 'version: 1\ncmd: node child.mjs\nevents: Ir\nfl=???\n0 12\nsummary: 123456789\n';
    assert.equal(cachegrindTotal(text), 123456789);
  });

  it('refuses a file with no total', () => {
    assert.throws(() => cachegrindTotal('events: Ir\n'), /no summary line/);
    assert.throws(() => cachegrindTotal('summary: 0\n'), /bad Cachegrind total/);
  });
});

describe('slope', () => {
  it('keeps the cost of the extra iterations and drops the fixed cost', () => {
    const fixed = 90_000_000;
    assert.equal(slope({ iterations: 10, total: fixed + 10 * 5000 }, { iterations: 30, total: fixed + 30 * 5000 }), 5000);
  });

  it('refuses a high run with no more iterations, or less work', () => {
    assert.throws(() => slope({ iterations: 10, total: 1 }, { iterations: 10, total: 2 }), /more iterations/);
    assert.throws(() => slope({ iterations: 10, total: 500 }, { iterations: 30, total: 400 }), /non-positive slope/);
  });
});

describe('spreadOf', () => {
  it('measures the trial range against the median', () => {
    assert.deepEqual(spreadOf([1000, 1002, 999]), { median: 1000, min: 999, max: 1002, spreadPercent: 0.3 });
  });
});

describe('assess', () => {
  it('gives instruction counts a direction only when the ranges do not overlap', () => {
    assert.equal(assess('cachegrind', [1000, 1001, 1002], [990, 991, 992], 2).verdict, 'lower');
    assert.equal(assess('cachegrind', [1000, 1001, 1002], [1003, 1004, 1005], 2).verdict, 'higher');
    const overlap = assess('cachegrind', [1000, 1001, 1010], [990, 995, 1000], 2);
    assert.equal(overlap.verdict, 'inconclusive');
    assert.ok(overlap.changePercent < 0);
  });

  it('gives wall time a direction only when every round agrees and the median clears the threshold', () => {
    assert.equal(assess('time', [100, 100, 100], [90, 92, 95], 2).verdict, 'lower');
    assert.equal(assess('time', [100, 100, 100], [90, 92, 101], 2).verdict, 'inconclusive');
    assert.equal(assess('time', [100, 100, 100], [99, 99.5, 99], 2).verdict, 'same');
    assert.equal(assess('time', [100, 100, 100], [105, 110, 104], 2).verdict, 'higher');
  });

  it('needs the same number of trials on both sides', () => {
    assert.throws(() => assess('cachegrind', [1, 2], [1], 2), /same number of trials/);
  });
});

describe('format', () => {
  it('signs and rounds a percentage', () => {
    assert.equal(format(1.23456), '+1.235%');
    assert.equal(format(-0.5), '-0.5%');
    assert.equal(format(0), '0%');
  });
});

describe('renderSummary', () => {
  const side = (values: number[]) => ({ sha: 'a'.repeat(40), perIteration: values, spread: spreadOf(values) });
  const result = (sameCheckout: boolean, head: number[]): Result => ({
    tool: 'cachegrind',
    trials: 3,
    multiplier: 3,
    thresholdPercent: 2,
    sameCheckout,
    flags: { jit: ['--predictable'], jitless: ['--jitless', '--predictable'] },
    machine: 'linux x64',
    rows: [
      {
        case: 'redact/screen-text',
        mode: 'jit',
        base: side([1000, 1001, 1002]),
        head: side(head),
        assessment: assess('cachegrind', [1000, 1001, 1002], head, 2),
      },
    ],
  });

  it('renders a comparison row with its verdict and both spreads', () => {
    const text = renderSummary(result(false, [900, 901, 902]));
    assert.match(text, /\| `redact\/screen-text` \| jit \| 1,001 \| 901 \| -9\.99% \| 🟢 lower \(ranges do not overlap\) \| 0\.200% \| 0\.222% \|/);
    assert.match(text, /`jit`: `node --predictable`/);
    assert.doesNotMatch(text, /jitless/);
  });

  it('fails a repeatability check that finds a direction, and passes one that does not', () => {
    assert.equal(repeatabilityFailures(result(true, [900, 901, 902])).length, 1);
    assert.equal(repeatabilityFailures(result(true, [1000, 1001, 1002])).length, 0);
    assert.equal(repeatabilityFailures(result(false, [900, 901, 902])).length, 0);
  });

  it('renders a single checkout as a spread table', () => {
    const single: Result = { ...result(false, [1, 2, 3]), rows: [{ case: 'locate/catalog', mode: 'jitless', head: side([500, 505, 510]) }] };
    assert.match(renderSummary(single), /\| `locate\/catalog` \| jitless \| 505 \| 500 – 510 \| 1\.980% \|/);
  });
});
