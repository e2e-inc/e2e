import { describe, expect, it } from 'vitest';
import { publishAttempt } from '@e2e-dev/core/lib/expect/attempt';
import { SoftFailures } from '@e2e-dev/core/lib/expect/soft';
import { readRunningCondition } from '@e2e-dev/core/lib/internal/condition';
import { CollectionError, TestError } from '@e2e-dev/core/lib/internal/errors';
import { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import { Deadline } from '@e2e-dev/core/lib/internal/time';
import { test } from '../../src/collect/registry.ts';
import { parseModifierCall } from '../../src/internal/skip.ts';

const parse = (...args: unknown[]) => parseModifierCall(args);
const runtime = (condition: unknown, reason?: string) => ({ kind: 'runtime', condition, reason });
const read = (condition: unknown) => readRunningCondition('test.skip()', condition);

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
    expect(parse('later', 42)).toEqual(runtime('later'));
  });

  it('applies always in the reason form: no argument, or a lone string or undefined', () => {
    expect(parse()).toEqual(runtime(true));
    expect(parse(undefined)).toEqual(runtime(true));
    expect(parse('')).toEqual(runtime(true, ''));
    expect(parse('waiting on the API')).toEqual(runtime(true, 'waiting on the API'));
  });

  it('keeps any other first argument as the condition, for the API to read', () => {
    for (const condition of [undefined, null, false, 0, '', Number.NaN, true, 1, 'yes']) {
      expect(parse(condition, 'flaky on CI')).toEqual(runtime(condition, 'flaky on CI'));
    }
    for (const condition of [null, false, 0, 1]) {
      expect(parse(condition)).toEqual(runtime(condition));
    }
  });

  it('takes the reason from the second argument only', () => {
    expect(parse('1', 'the real reason')).toEqual(runtime('1', 'the real reason'));
    expect(parse(true, 42)).toEqual(runtime(true));
    expect(parse(undefined, undefined)).toEqual(runtime(undefined));
  });
});

describe('readRunningCondition', () => {
  it('reads the condition by truthiness, as Playwright does', () => {
    for (const falsy of [undefined, null, false, 0, '', Number.NaN]) {
      expect(read(falsy)).toBe(false);
    }
    for (const truthy of [true, 1, 'true', {}]) {
      expect(read(truthy)).toBe(true);
    }
  });

  it('refuses a Promise condition, which is always truthy, as INVALID_ARGUMENT', () => {
    expect(() => read(Promise.resolve(false))).toThrow(TestError);
    expect(() => read(Promise.resolve(false))).toThrow('test.skip() got a Promise as its condition; await it before the call');
  });

  it('refuses a function condition, which is always truthy, as INVALID_ARGUMENT', () => {
    expect(() => read(() => false)).toThrow(TestError);
    expect(() => read(() => false)).toThrow('test.skip() got a function as its condition; call it and pass the result');
  });
});

describe('test.skipIf and test.runIf', () => {
  it('refuse a Promise as a collection error, even inside a test body', () => {
    inBody(() => {
      expect(() => test.skipIf(Promise.resolve(false) as unknown as boolean)).toThrow(CollectionError);
      expect(() => test.runIf(Promise.resolve(true) as unknown as boolean)).toThrow(CollectionError);
    });
  });
});
