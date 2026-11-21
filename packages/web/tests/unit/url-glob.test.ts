import { toTextPattern } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import { urlPattern, urlPatternsEqual } from '../../src/url-glob.ts';

const BASE = 'http://localhost:3000/';

/** Whether `expected` matches `url`, as `waitForURL`, `route`, `unroute`, and `waitForResponse` read it. */
function matches(expected: string | RegExp, url: string, base = BASE): boolean {
  return urlPattern(expected, base).matches(url);
}

describe('URL globs', () => {
  it('reads a string as a glob, resolved against the base URL', () => {
    expect(matches('**/checkout', 'http://localhost:3000/checkout')).toBe(true);
    expect(matches('**/checkout', 'https://shop.test/checkout')).toBe(true);
    expect(matches('/orders/*', 'http://localhost:3000/orders/42')).toBe(true);
    expect(matches('/orders/*', 'http://other.test/orders/42')).toBe(false);
    expect(matches('a/*', 'http://localhost:3000/a/b')).toBe(true);
    expect(matches('https://*.example.com/**', 'https://shop.example.com/a')).toBe(true);
    expect(matches('https://*.example.com/**', 'https://example.com/a')).toBe(false);
  });

  it('keeps * in one segment, lets ** cross /, and reads {a,b} as either', () => {
    expect(matches('/orders/*', 'http://localhost:3000/orders/42/items')).toBe(false);
    expect(matches('/orders/**', 'http://localhost:3000/orders/42/items')).toBe(true);
    expect(matches('/a/**/b', 'http://localhost:3000/a/b')).toBe(true);
    expect(matches('/a/**/b', 'http://localhost:3000/a/x/y/b')).toBe(true);
    expect(matches('/{cart,checkout}', 'http://localhost:3000/cart')).toBe(true);
    expect(matches('/{cart,checkout}', 'http://localhost:3000/home')).toBe(false);
  });

  it('reads ? as a literal, the start of a query, which a later .. stays inside', () => {
    expect(matches('**/search?q=*', 'http://localhost:3000/search?q=shoes')).toBe(true);
    expect(matches('**/search?q=*', 'http://localhost:3000/searchXq=shoes')).toBe(false);
    expect(matches('**/search?q=?', 'http://localhost:3000/search?q=a')).toBe(false);
    expect(matches('**/v?', 'http://localhost:3000/v1')).toBe(false);
    expect(matches('/x*?q=1/../y', 'http://localhost:3000/xyz?q=1/../y')).toBe(true);
    expect(matches('/x*?q=1/../y', 'http://localhost:3000/y')).toBe(false);
  });

  it('globs the scheme, matching it and the host in any case, and keeps the path in its case', () => {
    expect(matches('http{,s}://localhost:3000/a', 'http://localhost:3000/a')).toBe(true);
    expect(matches('http{,s}://localhost:3000/a', 'https://localhost:3000/a')).toBe(true);
    expect(matches('http{,s}://localhost:3000/a', 'ftp://localhost:3000/a')).toBe(false);
    expect(matches('https://*.EXAMPLE.COM/**', 'https://shop.example.com/a')).toBe(true);
    expect(matches('https://*.example.com/A*', 'https://shop.example.com/abc')).toBe(false);
  });

  it('leaves a glob that starts with about: unresolved, and reads an escaped * and other characters as themselves', () => {
    expect(matches('about:*', 'about:blank')).toBe(true);
    expect(matches('/a\\*b', 'http://localhost:3000/a*b')).toBe(true);
    expect(matches('/a\\*b', 'http://localhost:3000/axb')).toBe(false);
    expect(matches('**/a.b', 'http://localhost:3000/a.b')).toBe(true);
    expect(matches('**/a.b', 'http://localhost:3000/aXb')).toBe(false);
  });

  it('matches text and spaces in any glob the way the browser encodes them', () => {
    expect(matches('/検索/*', 'http://localhost:3000/%E6%A4%9C%E7%B4%A2/1')).toBe(true);
    expect(matches('/検索?q=*', 'http://localhost:3000/%E6%A4%9C%E7%B4%A2?q=1')).toBe(true);
    expect(matches('**/検索?q=*', 'http://localhost:3000/%E6%A4%9C%E7%B4%A2?q=1')).toBe(true);
    expect(matches('/search?q=café*', 'http://localhost:3000/search?q=caf%C3%A9-1')).toBe(true);
    expect(matches('/files/my file*', 'http://localhost:3000/files/my%20file.pdf')).toBe(true);
    expect(matches('**/files/my file*', 'http://localhost:3000/files/my%20file.pdf')).toBe(true);
    expect(matches('**/files/my%20file*', 'http://localhost:3000/files/my%20file.pdf')).toBe(true);
    expect(matches('**/😀*', 'http://localhost:3000/%F0%9F%98%80x')).toBe(true);
  });

  it('restores each glob segment to its own place when the glob or the base holds text like a placeholder', () => {
    expect(matches('/$_2_$/x*', 'http://localhost:3000/$_2_$/xyz')).toBe(true);
    expect(matches('/$_2_$/x*', 'http://localhost:3000/xyz/$_2_$')).toBe(false);
    expect(matches('x*', 'http://localhost:3000/$_0_$/xyz', 'http://localhost:3000/$_0_$/')).toBe(true);
  });

  it('matches a string with no wildcard exactly, resolved against the base', () => {
    expect(matches('/search?q=shoes', 'http://localhost:3000/search?q=shoes')).toBe(true);
    expect(matches('/search?q=s', 'http://localhost:3000/search?q=shoes')).toBe(false);
    expect(matches('/api/flags', 'http://localhost:3000/api/flags')).toBe(true);
    expect(matches('/api/flags', 'http://x.test/api/flags')).toBe(false);
  });

  it('tests a RegExp against the full URL', () => {
    expect(matches(/\/orders\/\d+$/, 'http://localhost:3000/orders/7')).toBe(true);
    expect(matches(/api\/\w+$/, 'http://x.test/api/flags')).toBe(true);
    expect(matches(/api\/\w+$/, 'http://x.test/api/a/b')).toBe(false);
  });

  it('reads every string as Playwright does: an escape in one with no wildcard, and the empty string as any URL', () => {
    expect(matches('/a\\.b', 'http://localhost:3000/a.b')).toBe(true);
    expect(matches('', 'http://localhost:3000/orders/7')).toBe(true);
    expect(matches('', 'about:blank')).toBe(true);
  });

  it('labels a string resolved against the base, and a RegExp as written', () => {
    expect(urlPattern('**/checkout', BASE).label).toBe('**/checkout');
    expect(urlPattern('/orders', BASE).label).toBe('http://localhost:3000/orders');
    expect(urlPattern('/orders/*', BASE).label).toBe('http://localhost:3000/orders/*');
    expect(urlPattern(/orders/, BASE).label).toBe('/orders/');
  });

  it('refuses a nested or unbalanced { before anything is matched', () => {
    for (const glob of ['**/{a,{b}}', '**/{a', '**/a}']) {
      expect(() => urlPattern(glob, BASE), glob).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });
});

describe('urlPatternsEqual', () => {
  it('compares string and regexp forms structurally, which is how unroute finds a route', () => {
    expect(urlPatternsEqual(toTextPattern('**/a'), toTextPattern('**/a'))).toBe(true);
    expect(urlPatternsEqual(toTextPattern(/a/i), toTextPattern(/a/i))).toBe(true);
    expect(urlPatternsEqual(toTextPattern(/a/i), toTextPattern(/a/g))).toBe(false);
    expect(urlPatternsEqual(toTextPattern('a'), toTextPattern(/a/))).toBe(false);
  });
});
