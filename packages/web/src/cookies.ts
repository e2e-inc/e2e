/**
 * The cookies `browser.setCookies` takes, checked before the URL rule or the
 * browser sees them. Tests run as JavaScript, so the `Cookie` type alone is no
 * guard, and a cookie the browser would refuse is the test's mistake, not the
 * engine's.
 */

import { TestError } from '@e2e-dev/core/engine';
import type { Cookie } from './browser.ts';
import { describe } from './support.ts';

const COOKIE_KEYS = ['name', 'value', 'url', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'] as const;
const SAME_SITE = ['Strict', 'Lax', 'None'] as const;

/** Throws `INVALID_ARGUMENT` naming the first field the `Cookie` type does not allow. */
export function validateCookies(cookies: unknown): asserts cookies is readonly Cookie[] {
  if (!Array.isArray(cookies)) {
    throw new TestError('INVALID_ARGUMENT', `browser.setCookies takes an array of cookies, got ${describe(cookies)}`);
  }
  cookies.forEach((cookie: unknown, index) => {
    const problem = cookieProblem(cookie);
    if (problem !== undefined) throw new TestError('INVALID_ARGUMENT', `browser.setCookies cookies[${index}] ${problem}`);
  });
}

function cookieProblem(cookie: unknown): string | undefined {
  if (typeof cookie !== 'object' || cookie === null || Array.isArray(cookie)) {
    return `must be an object, got ${describe(cookie)}`;
  }
  const known: readonly string[] = COOKIE_KEYS;
  const unknown = Object.getOwnPropertyNames(cookie).find((key) => !known.includes(key));
  if (unknown !== undefined) return `has no key ${JSON.stringify(unknown)}; it takes ${COOKIE_KEYS.join(', ')}`;
  const field = (key: (typeof COOKIE_KEYS)[number]): unknown => Reflect.get(cookie, key);
  for (const key of ['name', 'value'] as const) {
    if (typeof field(key) !== 'string') return `${key} must be a string, got ${describe(field(key))}`;
  }
  for (const key of ['url', 'path'] as const) {
    if (field(key) !== undefined && typeof field(key) !== 'string') return `${key} must be a string, got ${describe(field(key))}`;
  }
  const domain = field('domain');
  if (domain !== undefined && (typeof domain !== 'string' || domain.trim() === '')) {
    return `domain must be a non-empty string, got ${describe(domain)}`;
  }
  if (field('url') !== undefined && (domain !== undefined || field('path') !== undefined)) {
    return 'takes url, or domain with an optional path, not both';
  }
  if (field('url') === undefined && domain === undefined) return 'needs a url, or a domain with an optional path';
  const expires = field('expires');
  if (expires !== undefined && (typeof expires !== 'number' || !Number.isFinite(expires))) {
    return `expires must be a Unix timestamp in seconds, got ${describe(expires)}`;
  }
  for (const key of ['httpOnly', 'secure'] as const) {
    if (field(key) !== undefined && typeof field(key) !== 'boolean') return `${key} must be a boolean, got ${describe(field(key))}`;
  }
  const sameSite = field('sameSite');
  if (sameSite !== undefined && !(SAME_SITE as readonly unknown[]).includes(sameSite)) {
    return `sameSite must be "Strict", "Lax", or "None", got ${describe(sameSite)}`;
  }
  return undefined;
}
