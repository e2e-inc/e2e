import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { bound, boundIsAmbiguous, compareText, createTextMatching, matchesText, normalizeRegexpFlags, normalizeText, testPattern, toTextPattern } from '@e2e-dev/core/lib/internal/text';

describe('normalizeText', () => {
  it('trims and collapses unicode whitespace runs to one ASCII space', () => {
    expect(normalizeText('  a \t\n b\u00a0c ')).toBe('a b c');
    expect(normalizeText('\u2003x\u2003')).toBe('x');
  });
});

describe('matchesText', () => {
  it('string matching is exact by default', () => {
    expect(matchesText('Sign in', { kind: 'string', value: 'Sign in', exact: true })).toBe(true);
    expect(matchesText('Sign in now', { kind: 'string', value: 'Sign in', exact: true })).toBe(false);
    expect(matchesText('  Sign\n in ', { kind: 'string', value: 'Sign in', exact: true })).toBe(true);
  });

  it('exact:false is case-insensitive substring matching', () => {
    expect(matchesText('Sign In Now', { kind: 'string', value: 'sign in', exact: false })).toBe(true);
    expect(matchesText('Sign In Now', { kind: 'string', value: 'log in', exact: false })).toBe(false);
  });

  it('resets global regexp state between matches', () => {
    const pattern = { kind: 'regexp', source: 'a', flags: 'g' } as const;
    expect(matchesText('a', pattern)).toBe(true);
    expect(matchesText('a', pattern)).toBe(true);
    expect(matchesText('a', pattern)).toBe(true);
  });
});

describe('compareText', () => {
  const contains = { mode: 'contains', normalize: true } as const;
  const raw = { mode: 'equals', normalize: false } as const;

  it('contains mode uses a case-sensitive substring for an exact string', () => {
    expect(compareText('Hello World', { kind: 'string', value: 'World', exact: true }, contains)).toBe(true);
    expect(compareText('Hello World', { kind: 'string', value: 'world', exact: true }, contains)).toBe(false);
  });

  it('normalize: false compares the raw strings, newlines and trailing spaces included', () => {
    const value = 'line1\n\nline2  ';
    expect(compareText(value, { kind: 'string', value: 'line1 line2', exact: true }, raw)).toBe(false);
    expect(compareText(value, { kind: 'string', value, exact: true }, raw)).toBe(true);
    expect(compareText(value, { kind: 'regexp', source: '^line1\\n\\nline2 {2}$', flags: '' }, raw)).toBe(true);
    expect(compareText(value, { kind: 'string', value: 'line1 line2', exact: true }, { ...raw, normalize: true })).toBe(true);
  });
});

describe('createTextMatching', () => {
  it('runs serialized, closing over nothing of its module', () => {
    // oxlint-disable-next-line no-new-func -- the page revives the rules from their source the same way
    const revived = (new Function(`return (${createTextMatching.toString()})`)() as typeof createTextMatching)();
    const global = { kind: 'regexp', source: 'b', flags: 'g' } as const;
    expect(revived.testPattern('^a', 'y', 'ab')).toBe(true);
    expect(revived.normalizeText('  a \t\n b\u00a0c ')).toBe('a b c');
    expect(revived.matchesText('  Sign\n in ', { kind: 'string', value: 'Sign in', exact: true })).toBe(true);
    expect(revived.matchesText('Sign In Now', { kind: 'string', value: 'sign in', exact: false })).toBe(true);
    expect(revived.matchesText('abc', global)).toBe(true);
    expect(revived.matchesText('abc', global)).toBe(true);
    expect(revived.compareText('Hello World', { kind: 'string', value: 'hello', exact: true }, { mode: 'contains', normalize: true, ignoreCase: true })).toBe(true);
  });

  it('gives every instance a pattern cache of its own, bounded', () => {
    const { testPattern: test } = createTextMatching();
    for (let index = 0; index < 600; index += 1) expect(test(`^${String(index)}$`, '', String(index))).toBe(true);
    expect(test('^0$', '', '0')).toBe(true);
    expect(() => test('(', '', 'x')).toThrow(SyntaxError);
    expect(() => testPattern('(', '', 'x')).toThrow(SyntaxError);
  });
});

describe('toTextPattern', () => {
  it('defaults strings to exact', () => {
    expect(toTextPattern('x')).toEqual({ kind: 'string', value: 'x', exact: true });
    expect(toTextPattern('x', { exact: false })).toEqual({ kind: 'string', value: 'x', exact: false });
  });

  it('serializes regexps with normalized flags', () => {
    expect(toTextPattern(/ab/gi)).toEqual({ kind: 'regexp', source: 'ab', flags: 'gi' });
  });

  it('accepts a RegExp from another realm', () => {
    expect(toTextPattern(runInNewContext('/ab/i') as RegExp)).toEqual({ kind: 'regexp', source: 'ab', flags: 'i' });
  });

  it('rejects anything but a string or a RegExp instead of matching everything', () => {
    for (const match of [(text: string) => text === 'x', { source: 'x', flags: '' }, undefined, null, 1]) {
      expect(() => toTextPattern(match as unknown as RegExp)).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('string or RegExp') }),
      );
    }
  });
});

describe('normalizeRegexpFlags', () => {
  it('sorts into canonical d,g,i,m,s,u,v,y order and de-duplicates', () => {
    expect(normalizeRegexpFlags('gid')).toBe('dgi');
    expect(normalizeRegexpFlags('yusmig')).toBe('gimsuy');
  });
});

describe('bound', () => {
  it('keeps text within its cap whole, and cuts longer text with an ellipsis, never through a surrogate pair', () => {
    expect(bound('short', 10)).toBe('short');
    expect(bound('abcdefghij', 5)).toBe('abcd…');
    // The cut lands between the halves of 😀; it steps back rather than leave half a character.
    expect(bound(`abc😀def`, 5)).toBe('abc…');
    expect(bound(`ab😀def`, 5)).toBe('ab😀…');
  });
});

describe('boundIsAmbiguous', () => {
  it('holds for text bound cuts and for text that ends like one of its cuts, and for nothing else', () => {
    expect(boundIsAmbiguous('abcdef', 5)).toBe(true);
    expect(boundIsAmbiguous('abcd…', 5)).toBe(true);
    expect(boundIsAmbiguous('abc…', 5)).toBe(true);
    expect(boundIsAmbiguous('abcde', 5)).toBe(false);
    expect(boundIsAmbiguous('ab…', 5)).toBe(false);
    expect(boundIsAmbiguous('loading…', 300)).toBe(false);
  });
});
