/**
 * Where a screen is, as a route rather than a URL.
 *
 * The replay precondition asks "is the app on the screen this recording
 * began on", and the postcondition "did we land where the recording landed".
 * A URL answers neither directly: it carries the id the app minted for this
 * run's record, a cache buster, a session token, a fragment. All of that
 * changes between two visits to the same screen, and none of it is the
 * screen.
 *
 * So a location is reduced to its route: the origin it is on, the pathname's
 * segments, and the query's parameters, with every segment or parameter
 * value that looks minted per record (a uuid, a hex or digit run, a long
 * token mixing letters and digits, a prefixed record id, text with
 * whitespace) replaced by `:id`.
 * Every other query value is part of the screen: `?mode=unsafe` is not
 * `?mode=safe`, and `?tab=notes` shows other controls than no tab. The
 * fragment is dropped, except that an app routing in the fragment
 * (`#/companies/1`) routes by that path and its query. A value the call
 * marked with `unique()` needs no rule here: the recording spells it as a
 * placeholder in every spelling a URL gives it, its slug included
 * (`cache/template.ts`), and replay fills in this run's value on both sides.
 *
 * The origin is relative to the app (`appLocation`): a location on the app's
 * own origin is kept as its path, so a recording made against one deployment
 * of the app replays on another that shares its `app.identity`, while a
 * screen on any other origin keeps its origin and is another route.
 *
 * Two routes are the same screen only when they read alike. A literal that
 * differs, a slug the runner never saw the value of, is another screen at
 * both ends of a step: nothing recorded can tell a record's slug from a
 * route word, and a screen that looks alike on another route (a settings
 * page and a profile page sharing one layout) is exactly where a wrong link
 * lands. A device engine reports a screen title in place of a URL, which is
 * already a route and compares as itself.
 */

type Route =
  | {
      readonly kind: 'url';
      /** The origin, absent for a location on the app's own origin (`appLocation`). */
      readonly origin?: string;
      /** The document's own path, for an app that routes in the fragment (`/app/#/orders/1`): not part of the route, kept to spell it. */
      readonly document?: string;
      readonly segments: readonly string[];
      /** One `[key, value]` pair per query parameter, minted keys and values as `:id`, sorted. */
      readonly query: readonly (readonly [string, string])[];
    }
  | { readonly kind: 'opaque'; readonly location: string };

const PARAM = ':id';

/**
 * A segment shaped like a value the app mints per record: a uuid, a hex or
 * digit run, a long token carrying letters and at least two digits (a route
 * word such as `companies-v2` has one), a prefixed record id (letters, a
 * dash, then a digit tail of two or more: `PROJ-016`, `INV-2041`; a single
 * digit as in `page-2` is a route word), or text with whitespace, which no
 * router puts in a path. Any other capitalized or dashed word is none of
 * these.
 */
const MINTED_SEGMENT: readonly RegExp[] = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{8,}$/i,
  /^\d+$/,
  /^(?=(?:[^\d]*\d){2})(?=.*[A-Za-z])[A-Za-z0-9_-]{12,}$/,
  /^[A-Za-z]+-\d{2,}$/,
  /\s/,
];

/**
 * A query value is minted on the same rules, with the wider alphabet a
 * value carries that a path segment cannot: a signed token or a timestamp
 * (`eyJhbGciOi.x1.y2`, `2026-10-01T10:00:00Z`) has dots, colons, and base64,
 * and a date (`?from=2026-10-01`, a default an app fills in with today) has
 * no letter at all.
 */
const MINTED_VALUE: readonly RegExp[] = [
  ...MINTED_SEGMENT,
  /^(?=(?:[^\d]*\d){2})(?=.*[A-Za-z])[\w.~+/=:-]{12,}$/,
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/,
];

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * A location as the cache compares it: a URL on the app's own origin as its
 * path, query, and fragment, so a recording follows the app to another
 * deployment of it; anything else (another origin, a device screen title)
 * as it is.
 */
export function appLocation(location: string, appOrigin: string | undefined): string {
  if (appOrigin === undefined || !URL.canParse(location)) return location;
  const url = new URL(location);
  return url.origin === appOrigin ? `${url.pathname}${url.search}${url.hash}` : location;
}

/** Scheme and authority as a URL parser skips them: leading whitespace and any run of slashes. */
const URL_ORIGIN_PREFIX = /^\s*[a-z][a-z\d+.-]*:[/\\]*[^/?#\\]*/i;

/**
 * A navigation as a recording keeps it: a URL on the app's origin without
 * that origin, the rest as typed. Anything else stays as given, and so does
 * a URL with credentials or a rest that would not open the same URL.
 */
export function appNavigation(url: string, appOrigin: string | undefined): string {
  if (appOrigin === undefined || !URL.canParse(url)) return url;
  const parsed = new URL(url);
  if (parsed.origin !== appOrigin || parsed.username !== '' || parsed.password !== '') return url;
  const prefix = URL_ORIGIN_PREFIX.exec(url)?.[0];
  if (prefix === undefined) return url;
  const rest = url.slice(prefix.length);
  const path = rest.startsWith('/') ? rest : `/${rest}`;
  return URL.canParse(path, appOrigin) && new URL(path, appOrigin).href === parsed.href ? path : url;
}

/**
 * The parts of a location its route is made of, or undefined when the
 * location is not a web address (a device engine's screen title, a
 * browser's own page).
 */
function locationParts(location: string): { readonly origin?: string; readonly document?: string; readonly pathname: string; readonly search: string } | undefined {
  let origin: string | undefined;
  let rest = location;
  if (URL.canParse(location)) {
    const url = new URL(location);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    origin = url.origin;
    rest = `${url.pathname}${url.search}${url.hash}`;
  } else if (!location.startsWith('/')) {
    return undefined;
  }
  const hashAt = rest.indexOf('#');
  const fragment = hashAt === -1 ? '' : rest.slice(hashAt + 1);
  const [documentPath, documentSearch] = splitOnce(hashAt === -1 ? rest : rest.slice(0, hashAt), '?');
  if (!fragment.startsWith('/')) return { ...(origin === undefined ? {} : { origin }), pathname: documentPath, search: documentSearch };
  const [fragmentPath, fragmentSearch] = splitOnce(fragment, '?');
  return {
    ...(origin === undefined ? {} : { origin }),
    document: documentPath,
    pathname: fragmentPath,
    search: [documentSearch, fragmentSearch].filter((part) => part !== '').join('&'),
  };
}

function splitOnce(text: string, separator: string): readonly [string, string] {
  const at = text.indexOf(separator);
  return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
}

/**
 * A query's parameters as `[key, value]` pairs, sorted; with `mint`, a
 * minted key or value as `:id`.
 */
function queryPairs(search: string, mint: boolean): (readonly [string, string])[] {
  const minted = (text: string) => mint && text !== '' && MINTED_VALUE.some((pattern) => pattern.test(text));
  const pairs: (readonly [string, string])[] = [];
  for (const [key, value] of new URLSearchParams(search)) pairs.push([minted(key) ? PARAM : key, minted(value) ? PARAM : value]);
  return pairs.toSorted(([a, x], [b, y]) => (a === b ? compareText(x, y) : compareText(a, b)));
}

/** Code-unit order, so a query's pairs sort alike on every machine. */
function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * The route of a location. With `mint`, every segment and query value
 * shaped like one the app mints per record reads `:id`; without, the
 * location's own words are kept, decoded, its fragment dropped as above.
 */
function routeOf(location: string, mint = true): Route {
  const parts = locationParts(location);
  if (parts === undefined) return { kind: 'opaque', location };
  const segments = parts.pathname
    .split('/')
    .filter((raw) => raw !== '')
    .map((raw) => segmentOf(raw, mint));
  return {
    kind: 'url',
    ...(parts.origin === undefined ? {} : { origin: parts.origin }),
    ...(parts.document === undefined ? {} : { document: parts.document }),
    segments,
    query: queryPairs(parts.search, mint),
  };
}

/** One path segment as a route reads it: decoded, and with `mint` `:id` when it is shaped like a minted value. */
function segmentOf(raw: string, mint: boolean): string {
  const text = decodeSegment(raw);
  return mint && MINTED_SEGMENT.some((pattern) => pattern.test(text)) ? PARAM : text;
}

/** Whether two locations name the same screen: one origin, and segments and query that read alike. */
export function sameRoute(recorded: string, live: string): boolean {
  return routeKey(recorded) === routeKey(live);
}

/** A location's route as one string: two locations are one screen exactly when their keys are equal (`sameRoute`). */
function routeKey(location: string): string {
  return routeIdentity(routeOf(location));
}

/**
 * Whether a location is spelled as a recording keeps it (`routeLocation`):
 * a segment or a query key or value reads `:id`, so its own record ids and
 * query values are gone and only that spelling can be compared.
 */
export function spelledAsRoute(location: string): boolean {
  const route = routeOf(location, false);
  return route.kind === 'url' && (route.segments.includes(PARAM) || route.query.some(([key, value]) => key === PARAM || value === PARAM));
}

/**
 * A location's address as one string, nothing read as minted: two
 * locations have equal keys only when they name the same record too
 * (`/orders/123/edit` is not `/orders/456/edit`). The fragment is dropped
 * as a route drops it, and the query's order does not count.
 */
export function addressKey(location: string): string {
  const route = routeOf(location, false);
  // Two documents that route the same fragment (`/#/menu`, `/about#/menu`) are two pages.
  return route.kind === 'url' && route.document !== undefined ? JSON.stringify([route.document, routeIdentity(route)]) : routeIdentity(route);
}

/**
 * A location as a recording keeps it: each path segment the app minted per
 * record, or shaped like a token, as `:id`, and every non-empty query value
 * as `:id`, its key kept.
 * A query value is often a token or a code (a magic link, an OAuth
 * callback), and one of letters only reads as a word to the route rule, so
 * no query value is written to an entry or a report. A path segment of
 * letters only reads as a route word and stays. A `<secret:name>` marker
 * the ledger put in its place stays readable. An app that routes in the
 * fragment keeps its document path and `#`. A device screen title, or any
 * other location that is not a web address, is kept as it is.
 *
 * The stored location names the screen for a reader; detours are found on
 * the live addresses before an entry is written (`cache/detours.ts`).
 */
export function routeLocation(location: string): string {
  const route = routeOf(location);
  if (route.kind === 'opaque') return unparsedLocation(location);
  // An app that routes in the fragment is spelled with its document path and `#`, so the location names a page it serves.
  const document = route.document === undefined ? '' : `${route.document.split('/').map((raw) => (raw === '' ? raw : storedSegment(decodeSegment(raw)))).join('/')}#`;
  const path = `/${route.segments.map(storedSegment).join('/')}`;
  const query = route.query.map(([key, value]) => `${spellPart(key)}=${value === '' ? '' : PARAM}`).join('&');
  return `${route.origin ?? ''}${document}${path}${query === '' ? '' : `?${query}`}`;
}

/**
 * A path segment as a recording keeps it: `:id` when it is shaped like a
 * value minted per record or a token (`MINTED_VALUE`: a signed token's dots
 * included, which a route never compares on), else as a URL spells it.
 */
function storedSegment(segment: string): string {
  return segment === PARAM || MINTED_VALUE.some((pattern) => pattern.test(segment)) ? PARAM : spellPart(segment);
}

/**
 * A web address the route rule does not read, as a recording keeps it: a
 * `file:` URL (a file app), or an address with a secret's marker the
 * ledger put in its host (`https://<secret:tenant>.example.org`), which is
 * no host a parser takes. Its scheme and authority stay as they read and
 * the rest is spelled as a path on them, so a query value it carries is
 * not kept either. Any other location is kept as it is.
 */
function unparsedLocation(location: string): string {
  if (!/^\s*(?:https?|file):/i.test(location)) return location;
  const authority = URL_ORIGIN_PREFIX.exec(location)?.[0] ?? '';
  const rest = location.slice(authority.length);
  return `${authority}${routeLocation(rest.startsWith('/') ? rest : `/${rest}`)}`;
}

/** A secret's marker as the ledger writes it (`internal/redact.ts`). */
const SECRET_MARKER = /(<secret:[A-Za-z0-9_.-]*>)/;

/** A UTF-16 surrogate with no partner: a unicode pattern reads a pair as one code point. */
const LONE_SURROGATE = /\p{Cs}/gu;

/**
 * One segment or query key as a URL spells it, `:id` and secret markers
 * kept as they read. A lone surrogate, which a location read from a cache
 * file can hold and `encodeURIComponent` throws on, is spelled as U+FFFD,
 * as a URL parser spells it.
 */
function spellPart(text: string): string {
  if (text === PARAM) return text;
  return text
    .split(SECRET_MARKER)
    .map((part, index) => (index % 2 === 1 ? part : encodeURIComponent(part.replace(LONE_SURROGATE, '\uFFFD'))))
    .join('');
}

/** A route's parts as one comparable string, a slash inside a segment kept inside it. */
function routeIdentity(route: Route): string {
  return JSON.stringify(route.kind === 'opaque' ? [route.location] : [route.origin ?? null, route.segments, route.query]);
}
