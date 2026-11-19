/**
 * A route's own fetch of the request it holds, the parts that never touch
 * the browser: the request sent again from Node with a Basic challenge
 * answered once, the response as the route reads it, and each `Set-Cookie`
 * header of it as a cookie for the browser's jar.
 */

import type { Network, Storage } from 'webdriver-bidi-protocol';
import type { HttpCredential } from '../protected-app.ts';

/** The upstream response a route's fetch read. */
export interface FetchedResponse {
  readonly url: string;
  readonly status: number;
  /** Header names lowercased; several `set-cookie` values are joined with `\n`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body's bytes, read once; rejects when the response ended before they all arrived. */
  body(): Promise<Buffer>;
}

/**
 * Sends a held request from Node, with the headers the browser sent it with
 * and its body bytes when it has one, and resolves with its response,
 * redirects not followed. A Basic challenge is answered once with
 * `credentials`, as the browser answers its own; a second 401 is the
 * response.
 */
export async function replayRequest(
  request: { readonly url: string; readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: Buffer },
  credentials: HttpCredential | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const send = (extra: Record<string, string>): Promise<Response> => fetch(request.url, {
    method: request.method,
    headers: { ...request.headers, ...extra },
    redirect: 'manual',
    signal,
    ...(request.body === undefined ? {} : { body: new Uint8Array(request.body) }),
  });
  const challenged = await send({});
  if (challenged.status !== 401 || credentials === undefined || !/^basic\b/i.test(challenged.headers.get('www-authenticate') ?? '')) return challenged;
  await challenged.body?.cancel();
  return send({ authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` });
}

/** The response Node got for the request to `url`, as the route reads it. */
export function fetchedResponse(url: string, fetched: Response): FetchedResponse {
  const headers = Object.fromEntries([...fetched.headers].filter(([name]) => name !== 'set-cookie'));
  const setCookies = fetched.headers.getSetCookie();
  let read: Promise<Buffer> | undefined;
  return {
    url,
    status: fetched.status,
    headers: setCookies.length === 0 ? headers : { ...headers, 'set-cookie': setCookies.join('\n') },
    body: () => (read ??= fetched.arrayBuffer().then((bytes) => Buffer.from(bytes))),
  };
}

/** A `Set-Cookie` cookie's path when the header gives none: the directory of `url`'s path (RFC 6265 default-path). */
function defaultCookiePath(url: URL): string {
  const directory = url.pathname.slice(0, url.pathname.lastIndexOf('/'));
  return directory === '' ? '/' : directory;
}

/**
 * One `Set-Cookie` header of a response from `url` as a cookie to store;
 * undefined for one with no name, or with a `Domain` the response's host does
 * not belong to, which a browser would refuse too. A cookie with a `Domain`
 * is for that domain and every host under it, which the jar reads from a
 * leading dot; one without is for the response's host alone.
 */
export function setCookieOf(header: string, url: URL): Storage.PartialCookie | undefined {
  const [pair = '', ...attributes] = header.split(';');
  const split = pair.indexOf('=');
  const name = pair.slice(0, split).trim();
  if (split <= 0 || name === '') return undefined;
  const attribute = new Map<string, string>();
  for (const each of attributes) {
    const at = each.indexOf('=');
    attribute.set((at === -1 ? each : each.slice(0, at)).trim().toLowerCase(), at === -1 ? '' : each.slice(at + 1).trim());
  }
  const domain = (attribute.get('domain') ?? '').toLowerCase();
  const bare = domain.replace(/^\./, '');
  if (bare !== '' && url.hostname !== bare && !url.hostname.endsWith(`.${bare}`)) return undefined;
  const path = attribute.get('path') ?? '';
  const sameSite = attribute.get('samesite')?.toLowerCase() ?? '';
  const maxAge = attribute.get('max-age') ?? '';
  const expires = Date.parse(attribute.get('expires') ?? '');
  const expiry = /^-?\d+$/.test(maxAge) ? Math.floor(Date.now() / 1000) + Number(maxAge) : Number.isNaN(expires) ? undefined : Math.floor(expires / 1000);
  return {
    name,
    value: { type: 'string', value: pair.slice(split + 1).trim() },
    domain: bare === '' ? url.hostname : `.${bare}`,
    path: path.startsWith('/') ? path : defaultCookiePath(url),
    ...(attribute.has('secure') ? { secure: true } : {}),
    ...(attribute.has('httponly') ? { httpOnly: true } : {}),
    ...(['strict', 'lax', 'none'].includes(sameSite) ? { sameSite: sameSite as Network.SameSite } : {}),
    ...(expiry === undefined ? {} : { expiry }),
  };
}
