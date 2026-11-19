import { describe, expect, it } from 'vitest';
import { chainParts, cssChains, tokenizeSelector } from '../../src/driver/selector-tokens.ts';

const kinds = (source: string) => tokenizeSelector(source).map((token) => [token.kind, token.text]);

describe('tokenizeSelector', () => {
  it('gives the source back when its tokens are joined', () => {
    for (const source of ['#a\\>b > .c', '[title="a ] b"] ~ p', ':is(a, b) + c', '#\\31 23', 'a\\', '"open', 'a) b (c', '🙂\\🙂 x']) {
      expect(tokenizeSelector(source).map((token) => token.text).join('')).toBe(source);
    }
  });

  it('reads an escaped character as one escape token', () => {
    expect(kinds('#a\\>b')).toEqual([['text', '#a'], ['escape', '\\>'], ['text', 'b']]);
    expect(kinds('#a\\ b')).toEqual([['text', '#a'], ['escape', '\\ '], ['text', 'b']]);
    expect(kinds('#a\\,b')).toEqual([['text', '#a'], ['escape', '\\,'], ['text', 'b']]);
  });

  it('reads a hex escape with up to six digits and one terminating whitespace', () => {
    expect(kinds('#\\31 23')).toEqual([['text', '#'], ['escape', '\\31 '], ['text', '23']]);
    expect(kinds('#\\31\r\n23')).toEqual([['text', '#'], ['escape', '\\31\r\n'], ['text', '23']]);
    expect(kinds('#\\00003123')).toEqual([['text', '#'], ['escape', '\\000031'], ['text', '23']]);
    expect(kinds('#\\31  x')).toEqual([['text', '#'], ['escape', '\\31 '], ['whitespace', ' '], ['text', 'x']]);
  });

  it('keeps a backslash at the end and a code point after one whole', () => {
    expect(kinds('a\\')).toEqual([['text', 'a'], ['escape', '\\']]);
    expect(kinds('\\🙂')).toEqual([['escape', '\\🙂']]);
  });

  it('classifies combinators, commas, and the chain separator outside groups and strings', () => {
    expect(kinds('a > b+c ~d, e >> f')).toEqual([
      ['text', 'a'], ['whitespace', ' '], ['combinator', '>'], ['whitespace', ' '], ['text', 'b'], ['combinator', '+'], ['text', 'c'],
      ['whitespace', ' '], ['combinator', '~'], ['text', 'd'], ['comma', ','], ['whitespace', ' '], ['text', 'e'], ['whitespace', ' '],
      ['chain', '>>'], ['whitespace', ' '], ['text', 'f'],
    ]);
  });

  it('reads strings and nested groups as single tokens', () => {
    expect(kinds('a[title="x \\" > y"]')).toEqual([['text', 'a'], ['group', '[title="x \\" > y"]']]);
    expect(kinds(':not(:is(a, b > c)) d')).toEqual([['text', ':not'], ['group', '(:is(a, b > c))'], ['whitespace', ' '], ['text', 'd']]);
    expect(kinds('[x=")"] y')).toEqual([['group', '[x=")"]'], ['whitespace', ' '], ['text', 'y']]);
    expect(kinds("'a >> b'")).toEqual([['string', "'a >> b'"]]);
  });
});

describe('chainParts', () => {
  /** The body of each part of `selector`. */
  const bodies = (selector: string): string[] => chainParts(selector).map((part) => part.body);

  it('splits on >> outside escapes, strings, and groups', () => {
    expect(bodies('article >> text=Hello')).toEqual(['article', 'Hello']);
    expect(bodies('text="a >> b" >> div')).toEqual(['"a >> b"', 'div']);
    expect(bodies('[title="a>>b"] >> p')).toEqual(['[title="a>>b"]', 'p']);
    expect(bodies('#a\\>>> b')).toEqual(['#a\\>', 'b']);
  });

  it('keeps an escaped space at the end of a part', () => {
    expect(bodies('#a\\  >> b')).toEqual(['#a\\ ', 'b']);
  });

  it('reads the engine of each part as Playwright does', () => {
    expect(chainParts('css=#a > b >> xpath=//li >> (//p)[2] >> text=Hi >> iframe[name="x=y"]')).toEqual([
      { engine: 'css', body: '#a > b', capture: false },
      { engine: 'xpath', body: '//li', capture: false },
      { engine: 'xpath', body: '(//p)[2]', capture: false },
      { engine: 'text', body: 'Hi', capture: false },
      { engine: 'css', body: 'iframe[name="x=y"]', capture: false },
    ]);
  });

  it('marks a capture only on a * before an engine prefix, and keeps CSS universals', () => {
    expect(chainParts('*css=article >> *text=Hi')).toEqual([
      { engine: 'css', body: 'article', capture: true },
      { engine: 'text', body: 'Hi', capture: true },
    ]);
    expect(chainParts('* >> * > button >> div > * >> css=*')).toEqual([
      { engine: 'css', body: '*', capture: false },
      { engine: 'css', body: '* > button', capture: false },
      { engine: 'css', body: 'div > *', capture: false },
      { engine: 'css', body: '*', capture: false },
    ]);
  });
});

describe('cssChains', () => {
  it('reads unescaped selectors as before', () => {
    expect(cssChains('a > b c+d ~ e')).toEqual([[
      { compound: 'a', combinator: null },
      { compound: 'b', combinator: '>' },
      { compound: 'c', combinator: ' ' },
      { compound: 'd', combinator: '+' },
      { compound: 'e', combinator: '~' },
    ]]);
    expect(cssChains(' a, b:nth-child(2n of c, d > e) ')).toEqual([[{ compound: 'a', combinator: null }], [{ compound: 'b:nth-child(2n of c, d > e)', combinator: null }]]);
    expect(cssChains('li:nth-child(2n+1)[data-x~="y z"]')).toEqual([[{ compound: 'li:nth-child(2n+1)[data-x~="y z"]', combinator: null }]]);
  });

  it('carries the selectors of :is(), :where(), :not(), and :has() apart from the rest of their compound', () => {
    expect(cssChains('b:is(c, d > e)')).toEqual([[{
      compound: 'b:is(c, d > e)', combinator: null, plain: 'b',
      nested: [{ name: 'is', chains: [[{ compound: 'c', combinator: null }], [{ compound: 'd', combinator: null }, { compound: 'e', combinator: '>' }]] }],
    }]]);
    expect(cssChains('a :WHERE(.x)[y]:not(.z)')).toEqual([[
      { compound: 'a', combinator: null },
      { compound: ':WHERE(.x)[y]:not(.z)', combinator: ' ', plain: '[y]', nested: [{ name: 'is', chains: [[{ compound: '.x', combinator: null }]] }, { name: 'not', chains: [[{ compound: '.z', combinator: null }]] }] },
    ]]);
    expect(cssChains(':has(> i, u)')).toEqual([[{
      compound: ':has(> i, u)', combinator: null, plain: '*',
      nested: [{ name: 'has', chains: [[{ compound: ':scope', combinator: null }, { compound: 'i', combinator: '>' }], [{ compound: 'u', combinator: null }]] }],
    }]]);
    expect(cssChains('s:not(:has(b))')).toEqual([[{
      compound: 's:not(:has(b))', combinator: null, plain: 's',
      nested: [{ name: 'not', chains: [[{ compound: ':has(b)', combinator: null, plain: '*', nested: [{ name: 'has', chains: [[{ compound: 'b', combinator: null }]] }] }]] }],
    }]]);
  });

  it('leaves to the browser a pseudo-class it cannot match itself', () => {
    expect(cssChains('s:has(+ p)')).toEqual([[{ compound: 's:has(+ p)', combinator: null }]]);
    expect(cssChains('s:is(> p)')).toEqual([[{ compound: 's:is(> p)', combinator: null }]]);
    expect(cssChains('s:is(a')).toEqual([[{ compound: 's:is(a', combinator: null }]]);
    expect(cssChains('s:is()')).toEqual([[{ compound: 's:is()', combinator: null }]]);
    expect(cssChains('.a\\:is(b)')).toEqual([[{ compound: '.a\\:is(b)', combinator: null }]]);
  });

  it('keeps escaped combinators, commas, and whitespace inside their compound', () => {
    expect(cssChains('#a\\>b')).toEqual([[{ compound: '#a\\>b', combinator: null }]]);
    expect(cssChains('#a\\ b > i')).toEqual([[{ compound: '#a\\ b', combinator: null }, { compound: 'i', combinator: '>' }]]);
    expect(cssChains('#a\\,b, c')).toEqual([[{ compound: '#a\\,b', combinator: null }], [{ compound: 'c', combinator: null }]]);
    expect(cssChains('#\\31 23 span')).toEqual([[{ compound: '#\\31 23', combinator: null }, { compound: 'span', combinator: ' ' }]]);
  });
});
