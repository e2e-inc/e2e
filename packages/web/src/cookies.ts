/**
 * The cookies `browser.setCookies` takes, checked before the URL rule or the
 * browser sees them. Tests run as JavaScript, so the `Cookie` type alone is no
 * guard, and a cookie the browser would refuse is the test's mistake, not the
 * engine's.
 */

import { domainToASCII } from 'node:url';
import { rejectUnknownKeys, TestError } from '@e2e-dev/core/engine';
import type { Cookie } from './browser.ts';
import { describe } from './support.ts';

const COOKIE_KEYS = ['name', 'value', 'url', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'] as const;
const SAME_SITE = ['Strict', 'Lax', 'None'] as const;

/** Throws `INVALID_ARGUMENT` naming the first field the `Cookie` type does not allow. */
export function validateCookies(cookies: unknown): asserts cookies is readonly Cookie[] {
  if (!Array.isArray(cookies)) {
    throw new TestError('INVALID_ARGUMENT', `browser.setCookies takes an array of cookies, got ${describe(cookies)}`);
  }
  for (const [index, cookie] of cookies.entries()) {
    const label = `browser.setCookies cookies[${index}]`;
    if (typeof cookie !== 'object' || cookie === null || Array.isArray(cookie)) {
      throw new TestError('INVALID_ARGUMENT', `${label} must be an object, got ${describe(cookie)}`);
    }
    rejectUnknownKeys(label, cookie, COOKIE_KEYS, 'INVALID_ARGUMENT');
    const problem = cookieProblem(cookie);
    if (problem !== undefined) throw new TestError('INVALID_ARGUMENT', `${label} ${problem}`);
  }
}

function cookieProblem(cookie: object): string | undefined {
  const field = (key: (typeof COOKIE_KEYS)[number]): unknown => Reflect.get(cookie, key);
  for (const key of ['name', 'value'] as const) {
    if (typeof field(key) !== 'string') return `${key} must be a string, got ${describe(field(key))}`;
  }
  for (const key of ['url', 'path'] as const) {
    if (field(key) !== undefined && typeof field(key) !== 'string') return `${key} must be a string, got ${describe(field(key))}`;
  }
  const domain = field('domain');
  if (domain !== undefined && (typeof domain !== 'string' || !isHostName(domain))) {
    return `domain must be a host name like "example.com" or ".example.com", got ${describe(domain)}`;
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

/**
 * Whether `domain`, less a leading dot, parses back as only that host in the
 * origin `setCookies` checks it under: no scheme, port, path, or whitespace,
 * which the browser would otherwise drop or read as another host.
 */
function isHostName(domain: string): boolean {
  const host = domain.replace(/^\./, '');
  if (!URL.canParse(`http://${host}`)) return false;
  const url = new URL(`http://${host}`);
  return url.href === `http://${url.hostname}/` && url.hostname === domainToASCII(host);
}
