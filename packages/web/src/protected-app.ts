/**
 * Protected-preview access, scoped to exact origins: the app's own and the
 * extras `credentialOrigins` lists. The configured headers ride requests
 * that start at one of them, and basic-auth credentials answer only a
 * challenge one of them issues. Nothing here changes once built.
 */

import type { ResolveSecretOptions, Secret } from '@e2e-dev/core/engine';
import type { WebBasicAuth } from './options.ts';

/** The credentials the browser answers an HTTP authentication challenge with. */
export interface HttpCredential {
  readonly username: string;
  readonly password: string;
}

/** An HTTP header field name: one or more `token` characters (RFC 9110). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** A control character no HTTP field value may carry; a horizontal tab is the one the grammar allows. */
// oxlint-disable-next-line no-control-regex -- the control characters are the point
export const FIELD_VALUE_CONTROL = /[\u0000-\u0008\u000A-\u001F\u007F]/;

/**
 * Why the browser could not send this header, or `undefined` when it can: a
 * name outside the token grammar, a value that is not a string, or one
 * carrying a control character (a line break is a header-injection vector).
 * Config and route overrides both check headers here.
 */
export function headerProblem(name: string, value: unknown): string | undefined {
  if (!HEADER_NAME.test(name)) return `has an invalid header name: "${name}"`;
  if (typeof value !== 'string') return `header "${name}" must be a string, got ${typeof value}`;
  if (FIELD_VALUE_CONTROL.test(value)) return `header "${name}" must not contain a control character`;
  return undefined;
}

/** Header names lowercased, as the browser reports a request's own headers. */
export function lowercaseNames(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/**
 * One attempt's access to a protected app: the exact origins it is scoped
 * to, the configured headers a request that starts at one of them carries,
 * and the credentials that answer a basic-auth challenge one of them issues.
 */
export class ProtectedApp {
  /** The configured headers, names lowercased. */
  private readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    private readonly origins: ReadonlySet<string>,
    headers: Readonly<Record<string, string>> | undefined,
    private readonly credentials: HttpCredential | undefined,
  ) {
    this.headers = headers === undefined ? undefined : lowercaseNames(headers);
  }

  /** Whether headers are configured: every request is then held to add them, and service workers, whose requests are never held, are blocked. */
  get sendsHeaders(): boolean {
    return this.headers !== undefined;
  }

  /** Whether credentials are configured, so basic-auth challenges are held to answer. */
  get answersChallenges(): boolean {
    return this.credentials !== undefined;
  }

  /** The configured headers a request that starts at `url` carries: all of them at one of the origins, none anywhere else. */
  headersFor(url: string): Readonly<Record<string, string>> | undefined {
    return this.covers(url) ? this.headers : undefined;
  }

  /** The credentials that answer a basic-auth challenge from `url`: the configured ones at one of the origins, none anywhere else. */
  credentialsFor(url: string): HttpCredential | undefined {
    return this.covers(url) ? this.credentials : undefined;
  }

  /** Whether `url` parses and its origin, as `URL.origin` serializes it, is one of the origins: the same scheme, host, and port. */
  private covers(url: string): boolean {
    return URL.canParse(url) && this.origins.has(new URL(url).origin);
  }
}

/**
 * The basic-auth credentials an attempt answers a challenge from one of its
 * credential origins with. A
 * `Secret` password resolves through the attempt, which registers the value
 * for redaction, and the `Authorization` credential the browser sends with it
 * too: a page that echoes its request headers shows that, not the password.
 */
export async function httpCredentials(
  basicAuth: WebBasicAuth,
  resolveSecret: (secret: Secret, options?: ResolveSecretOptions) => Promise<string>,
): Promise<HttpCredential> {
  const { username, password } = basicAuth;
  if (typeof password === 'string') return { username, password };
  return { username, password: await resolveSecret(password, { derived: (plaintext) => basicCredentials(username, plaintext) }) };
}

/**
 * The credential an `Authorization: Basic` header carries for `username` and
 * `password`, base64 of `username:password` as the browser encodes it, with
 * and without its `=` padding: an echo may drop or escape the padding.
 */
function basicCredentials(username: string, password: string): string[] {
  const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  const unpadded = encoded.replace(/={1,2}$/, '');
  return unpadded === encoded ? [encoded] : [encoded, unpadded];
}

/**
 * The exact origins the credentials go to: the app's own, when the runner
 * reports one, and each of `credentialOrigins`, normalized as `URL.origin`
 * serializes it. Config load has checked every extra is an origin.
 */
export function credentialOrigins(appOrigin: string | undefined, extras: readonly string[] | undefined): ReadonlySet<string> {
  return new Set([...(appOrigin === undefined ? [] : [appOrigin]), ...(extras ?? []).map((origin) => new URL(origin).origin)]);
}

/**
 * Why `value` is not an origin a credential can be scoped to, or `undefined`
 * when it is: an `http:` or `https:` URL with no user info, path, query, or
 * fragment (`https://api.example.com`, a trailing `/` allowed). A `*` in the
 * host and port `0` parse as URLs but match no request, so they are refused
 * too, rather than loading a config that sends nothing.
 */
export function originProblem(value: unknown): string | undefined {
  const expected = 'must be an origin such as "https://preview.example.com": an http or https URL with no path, query, or fragment';
  if (typeof value !== 'string') return `${expected}, got ${typeof value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${expected}, got "${value}"`;
  }
  if (url.hostname.includes('*')) return `must be an exact origin, got "${value}": a wildcard matches no request, so list each origin`;
  if (url.port === '0') return `must name the port requests use, got "${value}": port 0 matches no request`;
  const bare = url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '' && !value.endsWith('?') && !value.endsWith('#');
  return (url.protocol === 'http:' || url.protocol === 'https:') && bare ? undefined : `${expected}, got "${value}"`;
}
