import { describe, expect, it } from 'vitest';
import { publishAttempt } from '@e2e-dev/core/lib/expect/attempt';
import { SoftFailures } from '@e2e-dev/core/lib/expect/soft';
import { CollectionError, TestError } from '@e2e-dev/core/lib/internal/errors';
import { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import { Deadline } from '@e2e-dev/core/lib/internal/time';
import { test } from '../../src/collect/registry.ts';
import { parseModifierCall } from '../../src/internal/skip.ts';

const parse = (...args: unknown[]) => parseModifierCall('test.skip()', args);
const runtime = (condition: boolean, reason?: string) => ({ kind: 'runtime', condition, reason });

/** Runs `body` while a test attempt is running, as a test body does. */
const inBody = (body: () => void): void => {
  const end = new AbortController();
  publishAttempt(
    {
      attemptId: 'a',
      owner: 'suite',
      testKind: 'test',
      assertionTimeout: 1000,
      budget: new AttemptBudget(end.signal, new Deadline(1000)),
      soft: new SoftFailures(),
    },
    end.signal,
  );
  try {
    body();
  } finally {
    end.abort();
  }
};

describe('parseModifierCall', () => {
  it('registers a test for a title and a body', () => {
    const fn = () => {};
    expect(parse('later', fn)).toEqual({ kind: 'register', title: 'later', fn });
    expect(parse(true, fn)).toEqual(runtime(true));
    expect(parse('later', 42)).toEqual(runtime(true));
  });

  it('skips always in the reason form: no argument, or a lone string or undefined', () => {
    expect(parse()).toEqual(runtime(true));
    expect(parse(undefined)).toEqual(runtime(true));
    expect(parse('')).toEqual(runtime(true, ''));
    expect(parse('waiting on the API')).toEqual(runtime(true, 'waiting on the API'));
  });

  it('reads the first argument as a condition by truthiness, as Playwright does', () => {
    for (const falsy of [undefined, null, false, 0, '', Number.NaN]) {
      expect(parse(falsy, 'flaky on CI')).toEqual(runtime(false, 'flaky on CI'));
    }
    for (const falsy of [null, false, 0, Number.NaN]) {
      expect(parse(falsy)).toEqual(runtime(false));
    }
    for (const truthy of [true, 1, 'true', {}]) {
      expect(parse(truthy, 'flaky on CI')).toEqual(runtime(true, 'flaky on CI'));
    }
    expect(parse(1)).toEqual(runtime(true));
  });

  it('takes the reason from the second argument only', () => {
    expect(parse('1', 'the real reason')).toEqual(runtime(true, 'the real reason'));
    expect(parse(true, 42)).toEqual(runtime(true));
    expect(parse(undefined, undefined)).toEqual(runtime(false));
  });

  it('refuses a Promise condition, which is always truthy, inside a test body', () => {
    inBody(() => {
      expect(() => parse(Promise.resolve(false), 'async check')).toThrow(TestError);
      expect(() => parse(Promise.resolve(false))).toThrow('test.skip() got a Promise as its condition; await it before the call');
    });
  });

  it('leaves a Promise condition outside a test body to the skip, which refuses the call itself', () => {
    expect(parse(Promise.resolve(false), 'async check')).toEqual(runtime(true, 'async check'));
  });

  it('keeps test.skipIf and test.runIf refusing a Promise as a collection error, even inside a test body', () => {
    inBody(() => {
      expect(() => test.skipIf(Promise.resolve(false) as unknown as boolean)).toThrow(CollectionError);
      expect(() => test.runIf(Promise.resolve(true) as unknown as boolean)).toThrow(CollectionError);
    });
  });
});
