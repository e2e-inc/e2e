/**
 * `cookieTargets`, where each cookie of `browser.setCookies` lands: a `url`
 * gives its host, its directory, and `secure` for `https:`, a `domain` its
 * own domain and path. A cookie that names its own `url` or `domain` needs
 * no app URL, so it is set on a target with none (`attachBrowser`), and one
 * that names neither is refused by name.
 */

import { describe, expect, it } from 'vitest';
import { ConfigurationError, type EngineFixtureContext } from '@e2e-dev/core/engine';
import { cookieTargets } from '../../src/fixture/arguments.ts';
import type { Cookie } from '../../src/fixture/types.ts';

/** A fixture context whose app resolves URLs as the harness does: against `base`, or `APP_URL_REQUIRED` for a relative one without it. */
function contextOf(base: string | undefined): EngineFixtureContext {
  const resolveUrl = (url: string): string => {
    if (base === undefined && !URL.canParse(url)) throw new ConfigurationError('APP_URL_REQUIRED', `navigation to "${url}" needs an app URL; the target declares no app.url`);
    return new URL(url, base).href;
  };
  return { app: { ...(base === undefined ? {} : { site: new URL(base).hostname }), resolveUrl } } as unknown as EngineFixtureContext;
}

describe('cookieTargets', () => {
  it('lands a url cookie on the host and directory of the URL it resolves to and a domain cookie on its domain and path', () => {
    const cookies: Cookie[] = [
      { name: 'a', value: '1', url: '/account' },
      { name: 'b', value: '2', url: '/account/settings' },
      { name: 'c', value: '3', domain: '.app.test' },
      { name: 'd', value: '4', domain: 'app.test', path: '/admin' },
    ];
    expect(cookieTargets(cookies, contextOf('https://app.test/'))).toEqual([
      { cookie: cookies[0], domain: 'app.test', path: '/', secure: true },
      { cookie: cookies[1], domain: 'app.test', path: '/account/', secure: true },
      { cookie: cookies[2], domain: '.app.test', path: '/', secure: false },
      { cookie: cookies[3], domain: 'app.test', path: '/admin', secure: false },
    ]);
  });

  it('is secure for an https url unless the cookie says, and for a domain only when the cookie says', () => {
    const placed = cookieTargets([
      { name: 'a', value: '1', url: 'http://app.test/' },
      { name: 'b', value: '2', url: 'http://app.test/', secure: true },
      { name: 'c', value: '3', url: 'https://app.test/', secure: false },
      { name: 'd', value: '4', domain: 'app.test', secure: true },
    ], contextOf('https://app.test/'));
    expect(placed.map(({ secure }) => secure)).toEqual([false, true, false, true]);
  });

  it('needs no app URL for a cookie that names its own url or domain', () => {
    const cookies: Cookie[] = [
      { name: 'a', value: '1', url: 'https://other.test/account' },
      { name: 'b', value: '2', domain: 'other.test' },
    ];
    expect(cookieTargets(cookies, contextOf(undefined))).toEqual([
      { cookie: cookies[0], domain: 'other.test', path: '/', secure: true },
      { cookie: cookies[1], domain: 'other.test', path: '/', secure: false },
    ]);
  });

  it('refuses a relative url without an app URL, a target that is not http(s), and a cookie that names neither', () => {
    expect(() => cookieTargets([{ name: 'a', value: '1', url: '/account' }], contextOf(undefined))).toThrow(expect.objectContaining({ code: 'APP_URL_REQUIRED' }));
    expect(() => cookieTargets([{ name: 'a', value: '1', url: 'about:blank' }], contextOf(undefined))).toThrow(expect.objectContaining({ code: 'POLICY_DENIED', message: 'cookie URL must be http(s): about:blank' }));
    for (const base of ['https://app.test/', undefined]) {
      expect(() => cookieTargets([{ name: 'nowhere', value: '1' } as unknown as Cookie], contextOf(base))).toThrow(
        expect.objectContaining({ code: 'INVALID_ARGUMENT', message: 'browser.setCookies: cookie "nowhere" needs a url or a domain' }),
      );
    }
  });

  it('refuses a name or a value no browser stores, by the name alone', () => {
    const refusal = (name: string, value: string): unknown => {
      try {
        cookieTargets([{ name, value, url: 'https://app.test/' }], contextOf(undefined));
        return undefined;
      } catch (cause) {
        return { code: (cause as { code?: string }).code, message: (cause as Error).message };
      }
    };
    const why = 'is one no browser stores: it holds a ";" or a control character, or starts or ends with a space';
    for (const value of ['v w;', 'a;b', 'a\nb', 'a\tb', ' a', 'a ', 'a\u0000b', 'a\u007fb']) {
      expect(refusal('k', value)).toEqual({ code: 'INVALID_ARGUMENT', message: `browser.setCookies: the value of cookie "k" ${why}` });
    }
    for (const name of ['k=1', 'k;', ' k', 'k\n']) {
      expect(refusal(name, 'v')).toEqual({ code: 'INVALID_ARGUMENT', message: `browser.setCookies: the name of cookie ${JSON.stringify(name)} ${why.replace('";"', '";", a "="')}` });
    }
    for (const [name, value] of [['k', 'v w'], ['k', 'a"b'], ['k', 'a,b'], ['k', 'a=b'], ['k', ''], ['k v', 'v'], ['k', 'é']] as const) expect(refusal(name, value)).toBeUndefined();
  });
});
