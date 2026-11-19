/**
 * A user context's cookie jar over `storage.*`: the cookies as the browser
 * holds them, and as the `browser` fixture reads, sets, and clears them.
 */

import type { Network, Storage } from 'webdriver-bidi-protocol';
import { BidiError } from '../errors.ts';
import type { Cookie, CookieFields, CookieFilter } from '../fixture/types.ts';
import type { BidiConnection } from './connection.ts';
import { bytesText } from './network-wire.ts';
import type { BidiSession } from './session.ts';

/** One cookie of `browser.setCookies` with where the browser stores it: its domain, its path, and whether it is secure. */
export interface CookieTarget {
  readonly cookie: CookieFields;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
}

/** The fields a cookie filter matches on. */
const FILTER_FIELDS = ['name', 'domain', 'path'] as const;

/** The attempt's cookies, as the fixture reports them. */
export async function readCookies(session: BidiSession): Promise<Cookie[]> {
  return (await storedCookies(session.connection, session.userContext.id)).map(toCookie);
}

/** Stores each cookie of `targets` (`cookieTargets`) where it lands, in the attempt's user context. */
export async function writeCookies(session: BidiSession, targets: readonly CookieTarget[]): Promise<void> {
  for (const target of targets) await storeCookie(session.connection, session.userContext.id, partialCookie(target));
}

/**
 * Deletes the cookies every field of `filter` matches, a string exactly and
 * a RegExp by its text; no filter deletes every one. The browser matches
 * strings itself; a RegExp is matched here, against the cookies it holds.
 */
export async function deleteCookies(session: BidiSession, filter: CookieFilter | undefined): Promise<void> {
  const filters = FILTER_FIELDS.every((field) => typeof filter?.[field] !== 'object')
    ? [Object.fromEntries(FILTER_FIELDS.flatMap((field) => (filter?.[field] === undefined ? [] : [[field, filter[field]]])))]
    : (await storedCookies(session.connection, session.userContext.id))
        .filter((cookie) => FILTER_FIELDS.every((field) => {
          const wanted = filter?.[field];
          return wanted === undefined || (typeof wanted === 'string' ? cookie[field] === wanted : new RegExp(wanted.source, wanted.flags).test(cookie[field]));
        }))
        .map(({ name, domain, path }) => ({ name, domain, path }));
  for (const each of filters) await session.connection.send('storage.deleteCookies', { filter: each, partition: partition(session.userContext.id) });
}

/** The cookies of `userContext`, as the browser holds them. */
export async function storedCookies(connection: BidiConnection, userContext: string): Promise<Network.Cookie[]> {
  return (await connection.send('storage.getCookies', { partition: partition(userContext) })).cookies;
}

/**
 * Stores one cookie in `userContext`'s jar. Chromium's refusal reaches here
 * as an object turned to text (`[object Object]`), which says nothing, so
 * the cookie is named in its place.
 */
export async function storeCookie(connection: BidiConnection, userContext: string, cookie: Storage.PartialCookie): Promise<void> {
  await connection.send('storage.setCookie', { cookie, partition: partition(userContext) }).catch((cause: unknown) => {
    if (!(cause instanceof BidiError) || !cause.detail.includes('[object Object]')) throw cause;
    throw new BidiError(cause.method, cause.error, `the browser refused cookie ${JSON.stringify(cookie.name)} for ${cookie.domain}`);
  });
}

/** The cookie partition of a user context. */
function partition(userContext: string): Storage.StorageKeyPartitionDescriptor {
  return { type: 'storageKey', userContext };
}

/** A fixture cookie as the browser stores it where it lands. */
function partialCookie({ cookie, domain, path, secure }: CookieTarget): Storage.PartialCookie {
  return {
    name: cookie.name,
    value: { type: 'string', value: cookie.value },
    domain,
    path,
    ...(cookie.expires !== undefined && cookie.expires >= 0 ? { expiry: Math.floor(cookie.expires) } : {}),
    ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
    secure,
    ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite.toLowerCase() as Network.SameSite } : {}),
  };
}

/** A BiDi cookie as the fixture reports it. */
function toCookie(cookie: Network.Cookie): Cookie {
  return {
    name: cookie.name,
    value: bytesText(cookie.value),
    domain: cookie.domain,
    path: cookie.path,
    ...(cookie.expiry === undefined ? {} : { expires: cookie.expiry }),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    ...(cookie.sameSite === 'default' ? {} : { sameSite: (cookie.sameSite[0]!.toUpperCase() + cookie.sameSite.slice(1)) as NonNullable<Cookie['sameSite']> }),
  };
}
