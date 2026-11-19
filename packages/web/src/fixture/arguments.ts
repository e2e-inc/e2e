/**
 * The `browser` fixture's argument checks: a navigation's `waitUntil`, cookie
 * targets, cookie filters, emulated media, and download counts.
 */

import { ConfigurationError, obj, rejectUnknownOptions, TestError, type EngineFixtureContext } from '@e2e-dev/core/engine';
import type { Browser, CookieFilter } from './types.ts';
import type { CookieTarget } from '../driver/cookies.ts';
import { WAIT_UNTIL, type WaitUntil } from '../driver/steering.ts';
import { choiceProblem, MEDIA_KEYS, mediaProblem, type WebMedia } from '../options.ts';

/** The app URL relative URLs resolve against; undefined for an app with no URL, which has no site either. */
export function baseHref(context: EngineFixtureContext): string | undefined {
  return context.app.site === undefined ? undefined : context.app.resolveUrl('');
}

/** The `waitUntil` `browser.goto` was given, `load` when it names none; refused unless it is one a navigation waits for. */
export function requireWaitUntil(options: Parameters<Browser['goto']>[1]): WaitUntil {
  const waitUntil = options?.waitUntil;
  if (waitUntil === undefined) return 'load';
  const problem = choiceProblem('browser.goto({ waitUntil })', WAIT_UNTIL, waitUntil);
  if (problem !== undefined) throw new TestError('INVALID_ARGUMENT', problem);
  return waitUntil;
}

/** What a browser refuses in a cookie's value: a `;`, a control character, or a space at either end. Refused here by the cookie's name, since a browser's refusal names neither the cookie nor the reason. */
// oxlint-disable-next-line no-control-regex -- the control characters are the point
const UNSTORABLE_VALUE = /[;\u0000-\u001f\u007f]|^ | $/;
/** What a browser refuses in a cookie's name: what it refuses in a value, and a `=`. */
// oxlint-disable-next-line no-control-regex -- the control characters are the point
const UNSTORABLE_NAME = /[=;\u0000-\u001f\u007f]|^ | $/;

/**
 * Each cookie of `browser.setCookies` with where it lands. The harness's URL
 * rule decides which targets are admitted; a domain cookie is checked as the
 * origin it would be sent to, under the app's scheme (`http` for an app with
 * no URL), and a relative `url` lands on the base URL the way `goto` would.
 * A `url` gives its host, its directory as the path, and `secure` for
 * `https:` unless the cookie says. A target that is not http(s) is
 * `POLICY_DENIED`; a cookie that names neither a `url` nor a `domain`, or
 * whose name or value no browser stores, is refused by name, never by
 * value.
 */
export function cookieTargets(cookies: Parameters<Browser['setCookies']>[0], context: EngineFixtureContext): CookieTarget[] {
  const scheme = (): string => {
    const base = baseHref(context);
    return base !== undefined && new URL(base).protocol === 'https:' ? 'https' : 'http';
  };
  return cookies.map((cookie) => {
    const unstorable = UNSTORABLE_NAME.test(cookie.name) ? 'name' : UNSTORABLE_VALUE.test(cookie.value) ? 'value' : undefined;
    if (unstorable !== undefined) {
      throw new TestError('INVALID_ARGUMENT', `browser.setCookies: the ${unstorable} of cookie ${JSON.stringify(cookie.name)} is one no browser stores: it holds a ";"${unstorable === 'name' ? ', a "="' : ''} or a control character, or starts or ends with a space`);
    }
    // A test is JavaScript at run time, so the type alone does not rule out a cookie that names neither.
    const named: { readonly url?: string; readonly domain?: string } = cookie;
    if (named.url === undefined && named.domain === undefined) {
      throw new TestError('INVALID_ARGUMENT', `browser.setCookies: cookie ${JSON.stringify(cookie.name)} needs a url or a domain`);
    }
    const target = context.app.resolveUrl(cookie.url ?? `${scheme()}://${cookie.domain.replace(/^\./, '')}`);
    if (!/^https?:/.test(target)) throw new ConfigurationError('POLICY_DENIED', `cookie URL must be http(s): ${target}`);
    if (cookie.url === undefined) return { cookie, domain: cookie.domain, path: cookie.path ?? '/', secure: cookie.secure ?? false };
    const { hostname, pathname, protocol } = new URL(target);
    return { cookie, domain: hostname, path: pathname.slice(0, pathname.lastIndexOf('/') + 1), secure: cookie.secure ?? protocol === 'https:' };
  });
}

/** Refuses a `browser.clearCookies` filter field that is neither a string nor a RegExp. */
export function requireCookieFilter(options: CookieFilter | undefined): void {
  rejectUnknownOptions('browser.clearCookies', options, ['name', 'domain', 'path']);
  for (const field of ['name', 'domain', 'path'] as const) {
    const value = options?.[field];
    if (value !== undefined && typeof value !== 'string' && !(value instanceof RegExp)) {
      throw new TestError('INVALID_ARGUMENT', `browser.clearCookies ${field} must be a string or RegExp`);
    }
  }
}

/** The media features `browser.emulateMedia` was given, checked and read once, so a later change to the object changes nothing. */
export function requireMedia(media: unknown): WebMedia {
  if (typeof media !== 'object' || media === null) {
    throw new TestError('INVALID_ARGUMENT', 'browser.emulateMedia takes { colorScheme?, reducedMotion? }');
  }
  rejectUnknownOptions('browser.emulateMedia', media, MEDIA_KEYS);
  const requested = media as WebMedia;
  for (const key of MEDIA_KEYS) {
    const problem = mediaProblem((name) => `browser.emulateMedia({ ${name} })`, key, requested[key]);
    if (problem !== undefined) throw new TestError('INVALID_ARGUMENT', problem);
  }
  return obj({ colorScheme: requested.colorScheme, reducedMotion: requested.reducedMotion });
}

/** The count `browser.waitForDownloads` was given, a positive safe integer. */
export function requireDownloadCount(options: Parameters<Browser['waitForDownloads']>[1] | undefined): number {
  rejectUnknownOptions('browser.waitForDownloads', options, ['count', 'timeout']);
  const count = options?.count;
  if (!Number.isSafeInteger(count) || count === undefined || count < 1) {
    throw new TestError('INVALID_ARGUMENT', 'waitForDownloads: count must be a positive safe integer');
  }
  return count;
}
