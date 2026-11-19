/**
 * Reaching an app behind a gate: configured request headers ride requests
 * that start at the app's origin, on every context the attempt opens, and
 * basic-auth credentials answer only its challenge. A request that starts at
 * another origin gets neither unless `credentialOrigins` lists it; a
 * redirect keeps the headers its request started with. Driven through the
 * engine hooks, as the attempt executor drives them; a second fixture
 * instance stands in for another origin, on the same host under another
 * port, and as `localhost` rather than `127.0.0.1` for a third-party site.
 * A challenge on each hop of a redirect goes to a gate of its own, reached
 * under both host names.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secrets } from 'e2e';
import type { EngineHandle, Secret } from '@e2e-dev/core/engine';
import type { Browser } from '../../src/index.ts';
import { PROTECTED_CREDENTIAL, startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';
import { browserFixture, byRole, cleanup, initInfo, onFirefox, operation, testWeb as web } from '../helpers/web-session.ts';

async function boot(
  engine: EngineHandle,
  app: Pick<FixtureApp, 'url'>,
  artifactsDir: string,
  attemptId: string,
  resolveSecret: (secret: Secret) => Promise<string> = noSecrets,
): Promise<void> {
  await engine.init!(initInfo({ app: { origin: new URL(app.url).origin, site: new URL(app.url).hostname } }));
  await engine.startAttempt!({ attemptId, artifactsDir, signal: new AbortController().signal, resolveSecret, ...ignoreTrace });
}

/** The engine's `browser` fixture for the open attempt. */
function browserOf(engine: EngineHandle, app: Pick<FixtureApp, 'url'>): Browser {
  return browserFixture(engine, { baseUrl: app.url, site: new URL(app.url).hostname });
}

async function shutdown(engine: EngineHandle): Promise<void> {
  await engine.endAttempt!(cleanup());
  await engine.dispose!(cleanup());
}

/** Navigates and reads the page's one heading. */
async function headingAt(engine: EngineHandle, attemptId: string, url: string): Promise<string> {
  await engine.session!.open!(url, operation(attemptId));
  const nodes = await engine.locate!(
    byRole('heading'),
    operation(attemptId),
  );
  return nodes[0]?.name ?? '';
}

/** The fixture's credential as the `Authorization` header a browser answers a Basic challenge with. */
const AUTHORIZATION = `Basic ${Buffer.from(`${PROTECTED_CREDENTIAL.username}:${PROTECTED_CREDENTIAL.password}`).toString('base64')}`;

/**
 * An app with one cacheable response: `/stamp` answers the number of
 * requests it got so far, fresh for an hour, and any other path a page.
 * `stamps` holds the `x-fixture-header` of each `/stamp` request, in order.
 */
function startCacheable(): Promise<Pick<FixtureApp, 'url' | 'close'> & { readonly stamps: (string | undefined)[] }> {
  const stamps: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    if (new URL(request.url ?? '/', 'http://cacheable.test').pathname !== '/stamp') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Cacheable</title><h1>Cacheable</h1>');
      return;
    }
    stamps.push([request.headers['x-fixture-header']].flat()[0]);
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'max-age=3600' });
    response.end(String(stamps.length));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
        stamps,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}

/** Names an empty icon for a page, so no browser requests `/favicon.ico` for it. */
const NO_ICON = '<link rel="icon" href="data:,">';

/**
 * A gate that challenges every request for the fixture's credential. With
 * it, `/hop?to=<url>` answers a redirect to `to`, `/locked` challenges
 * again whatever was sent, and any other path answers a page headed
 * `Through`. `asked` keeps the headers of the requests it got, by path. Its
 * pages name an empty icon, so Firefox asks the gate for none: that request
 * would be challenged at `/` beside the test's own.
 */
function startGate(): Promise<Pick<FixtureApp, 'url' | 'close'> & { readonly asked: Map<string, IncomingHttpHeaders[]> }> {
  const asked = new Map<string, IncomingHttpHeaders[]>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://gate.test');
    asked.set(url.pathname, [...(asked.get(url.pathname) ?? []), request.headers]);
    if (request.headers.authorization !== AUTHORIZATION || url.pathname === '/locked') {
      response.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'www-authenticate': 'Basic realm="gate"' });
      response.end(`<!doctype html><title>Gate</title>${NO_ICON}<h1>Unauthorized</h1>`);
      return;
    }
    const to = url.searchParams.get('to');
    if (url.pathname === '/hop' && to !== null) {
      response.writeHead(302, { location: to });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Gate</title>${NO_ICON}<h1>Through</h1>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
        asked,
        close: () => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}

describe('web({ headers, basicAuth })', () => {
  let app: FixtureApp;
  let other: FixtureApp;
  /** The second server under the app's host name: the same site, another origin. */
  let otherPort: string;
  /** The second server under another host name: `localhost` is a site of its own, `127.0.0.1` another. */
  let otherSite: string;
  let artifactsDir: string;

  beforeAll(async () => {
    [app, other] = await Promise.all([startFixtureApp(), startFixtureApp()]);
    otherPort = other.url;
    otherSite = other.url.replace('127.0.0.1', 'localhost');
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-protected-'));
  });

  afterAll(async () => {
    await Promise.all([app.close(), other.close()]);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('sends the headers to the app\'s origin only, on every context of the attempt', async () => {
    const engine = web({ headers: { 'X-Fixture-Header': 'let-me-in' } });
    try {
      await boot(engine, app, artifactsDir, 'h1');
      expect(await headingAt(engine, 'h1', `${app.url}/headers`)).toBe('let-me-in');
      // Another port on the same host, and a third-party site, get the request without them.
      expect(await headingAt(engine, 'h1', `${otherPort}/headers`)).toBe('none');
      expect(await headingAt(engine, 'h1', `${otherSite}/headers`)).toBe('none');
      // A state reset replaces the context; the headers come along.
      await engine.session!.reset!(operation('h1'));
      expect(await headingAt(engine, 'h1', `${app.url}/headers`)).toBe('let-me-in');
    } finally {
      await shutdown(engine);
    }
  });

  it('sends the headers to an origin credentialOrigins lists, and no other', async () => {
    const engine = web({ headers: { 'x-fixture-header': 'listed' }, credentialOrigins: [`${otherPort}/`] });
    try {
      await boot(engine, app, artifactsDir, 'h3');
      expect(await headingAt(engine, 'h3', `${otherPort}/headers`)).toBe('listed');
      expect(await headingAt(engine, 'h3', `${otherSite}/headers`)).toBe('none');
    } finally {
      await shutdown(engine);
    }
  });

  it('follows the origin a request starts on through its redirects', async () => {
    const engine = web({ headers: { 'x-fixture-header': 'rides-redirects' } });
    try {
      await boot(engine, app, artifactsDir, 'h4');
      // A redirect hop goes on with the headers its request started with:
      // they reach whatever origin a redirect names, and a redirect into the app's origin gets none.
      app.redirects.set('/to-other-headers', `${otherSite}/headers`);
      expect(await headingAt(engine, 'h4', `${app.url}/to-other-headers`)).toBe('rides-redirects');
      other.redirects.set('/to-app-headers', `${app.url}/headers`);
      expect(await headingAt(engine, 'h4', `${otherSite}/to-app-headers`)).toBe('none');
    } finally {
      await shutdown(engine);
    }
  });

  it('keeps the headers on a request an attempt route lets through', async () => {
    const engine = web({ headers: { 'x-fixture-header': 'through-the-route' } });
    try {
      await boot(engine, app, artifactsDir, 'h2');
      let routed = 0;
      // Registered after the header route, so it runs first.
      await browserOf(engine, app).route('**/headers', async (route) => {
        routed += 1;
        await route.fallback();
      });
      expect(await headingAt(engine, 'h2', `${app.url}/headers`)).toBe('through-the-route');
      expect(routed).toBe(1);
    } finally {
      await shutdown(engine);
    }
  });

  it('keeps the headers a request started with on every redirect hop, routed or not', async () => {
    const engine = web({ headers: { 'x-fixture-header': 'let-me-in' } });
    try {
      await boot(engine, app, artifactsDir, 'h5');
      const bounce = (from: string, to: string): string => `${from}/bounce?to=${encodeURIComponent(to)}`;
      expect(await headingAt(engine, 'h5', bounce(app.url, `${app.url}/headers`))).toBe('let-me-in > let-me-in');
      expect(await headingAt(engine, 'h5', bounce(app.url, bounce(otherSite, `${app.url}/headers`)))).toBe('let-me-in > let-me-in > let-me-in');
      expect(await headingAt(engine, 'h5', bounce(otherSite, bounce(app.url, `${app.url}/headers`)))).toBe('none > none > none');
      // A route that continues the request leaves the configured headers on it.
      await browserOf(engine, app).route('**/bounce?*', async (route) => {
        await route.continue({ headers: { ...route.request.headers, 'x-fixture-header': 'from-route' } });
      });
      expect(await headingAt(engine, 'h5', bounce(app.url, bounce(otherSite, `${app.url}/headers`)))).toBe('let-me-in > let-me-in > let-me-in');
      expect(await headingAt(engine, 'h5', bounce(otherSite, `${otherSite}/headers`))).toBe('from-route > from-route');
    } finally {
      await shutdown(engine);
    }
  });

  it('keeps the headers a request started with on the hop a redirect its route fulfilled leads to', async () => {
    const engine = web({ headers: { 'x-fixture-header': 'let-me-in' } });
    try {
      await boot(engine, app, artifactsDir, 'h6');
      await browserOf(engine, app).route('**/moved', async (route) => {
        await route.fulfill({ status: 302, headers: { location: `${app.url}/headers` } });
      });
      expect(await headingAt(engine, 'h6', `${app.url}/moved`)).toBe('let-me-in');
      // The request started at another origin, so its hop into the app's gets none.
      expect(await headingAt(engine, 'h6', `${otherSite}/moved`)).toBe('none');
    } finally {
      await shutdown(engine);
    }
  });

  it('blocks service workers under headers, since routing never sees a worker\'s requests', async () => {
    // Registers the fixture's worker and counts what the browser now holds:
    // a blocked registration resolves like a real one but registers nothing.
    const registrations = async (): Promise<number> => {
      await navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      return (await navigator.serviceWorker.getRegistrations()).length;
    };
    const registered = (engine: EngineHandle) => browserOf(engine, app).evaluate(registrations);
    const plain = web();
    try {
      await boot(plain, app, artifactsDir, 's0');
      await headingAt(plain, 's0', `${app.url}/`);
      // The fixture itself can register one: 127.0.0.1 is a secure context.
      expect(await registered(plain)).toBe(1);
    } finally {
      await shutdown(plain);
    }
    const engine = web({ headers: { 'x-fixture-header': 'no-workers' } });
    try {
      await boot(engine, app, artifactsDir, 's1');
      await headingAt(engine, 's1', `${app.url}/`);
      expect(await registered(engine)).toBe(0);
    } finally {
      await shutdown(engine);
    }
  });

  it('leaves the browser\'s HTTP cache on under headers', async () => {
    const cacheable = await startCacheable();
    const engine = web({ headers: { 'x-fixture-header': 'cached' } });
    try {
      await boot(engine, cacheable, artifactsDir, 'c1');
      await headingAt(engine, 'c1', `${cacheable.url}/`);
      const stamp = async (): Promise<string> => (await fetch('/stamp')).text();
      const read = () => browserFixture(engine, { baseUrl: cacheable.url }).evaluate(stamp);
      // The browser answers the second read from its cache: the server gets one request, with the headers.
      expect([await read(), await read()]).toEqual(['1', '1']);
      expect(cacheable.stamps).toEqual(['cached']);
    } finally {
      await shutdown(engine);
      await cacheable.close();
    }
  });

  it('answers a basic-auth challenge from the app\'s origin only', async () => {
    const unauthenticated = web();
    try {
      await boot(unauthenticated, app, artifactsDir, 'b0');
      expect(await headingAt(unauthenticated, 'b0', `${app.url}/protected`)).toBe('Unauthorized');
    } finally {
      await shutdown(unauthenticated);
    }
    const engine = web({ basicAuth: PROTECTED_CREDENTIAL });
    try {
      await boot(engine, app, artifactsDir, 'b1');
      expect(await headingAt(engine, 'b1', `${app.url}/protected`)).toBe('Protected');
      expect(await headingAt(engine, 'b1', `${otherPort}/protected`)).toBe('Unauthorized');
      expect(await headingAt(engine, 'b1', `${otherSite}/protected`)).toBe('Unauthorized');
      // The challenge comes from the origin a redirect lands on, so redirects do not carry the credential.
      app.redirects.set('/to-other-protected', `${otherPort}/protected`);
      expect(await headingAt(engine, 'b1', `${app.url}/to-other-protected`)).toBe('Unauthorized');
    } finally {
      await shutdown(engine);
    }
  });

  it('answers a challenge from an origin credentialOrigins lists, and no other', async () => {
    const engine = web({ basicAuth: PROTECTED_CREDENTIAL, credentialOrigins: [otherPort] });
    try {
      await boot(engine, app, artifactsDir, 'b2');
      expect(await headingAt(engine, 'b2', `${app.url}/protected`)).toBe('Protected');
      expect(await headingAt(engine, 'b2', `${otherPort}/protected`)).toBe('Protected');
      expect(await headingAt(engine, 'b2', `${otherSite}/protected`)).toBe('Unauthorized');
    } finally {
      await shutdown(engine);
    }
  });

  it.each([
    ['the response the credentials got, not on its challenge', PROTECTED_CREDENTIAL.password, 200, 'Protected'],
    ['the 401 when the credentials are refused', 'refused', 401, 'Unauthorized'],
  ])('resolves a response wait on %s', async (_name, password, status, heading) => {
    const engine = web({ basicAuth: { username: PROTECTED_CREDENTIAL.username, password } });
    try {
      await boot(engine, app, artifactsDir, 'w1');
      const [response, shown] = await Promise.all([
        browserOf(engine, app).waitForResponse('**/protected'),
        headingAt(engine, 'w1', `${app.url}/protected`),
      ]);
      expect([shown, response.status]).toEqual([heading, status]);
      await expect(response.text()).resolves.toContain(`<h1>${heading}</h1>`);
    } finally {
      await shutdown(engine);
    }
  });

  it('answers a challenge on each hop of a redirect through credential origins, once per hop', async () => {
    const gate = await startGate();
    const listed = gate.url.replace('127.0.0.1', 'localhost');
    const through = (target: string): string => `${gate.url}/hop?to=${encodeURIComponent(target)}`;
    const engine = web({ basicAuth: PROTECTED_CREDENTIAL, credentialOrigins: [listed] });
    try {
      await boot(engine, gate, artifactsDir, 'b3');
      expect(await headingAt(engine, 'b3', through(`${listed}/landing`))).toBe('Through');
      await engine.session!.reset!(operation('b3'));
      // The redirect's target refuses the credentials: asked bare, then with them, and its second challenge is the 401.
      expect(await headingAt(engine, 'b3', through(`${listed}/locked`))).toBe('Unauthorized');
      expect(gate.asked.get('/locked')).toHaveLength(2);
    } finally {
      await shutdown(engine);
      await gate.close();
    }
  });

  it('runs a route once for a request whose challenge is answered, and sends it again with the route\'s headers and the credentials', async () => {
    const gate = await startGate();
    const through = (target: string): string => `${gate.url}/hop?to=${encodeURIComponent(target)}`;
    const engine = web({ basicAuth: PROTECTED_CREDENTIAL, credentialOrigins: [gate.url.replace('127.0.0.1', 'localhost')] });
    try {
      await boot(engine, gate, artifactsDir, 'b4');
      const routed: string[] = [];
      // The override names no authorization header, on the first hop or on the hop the redirect leads to.
      await browserOf(engine, gate).route(/\/(landing|hop)/, async (route) => {
        routed.push(new URL(route.request.url).pathname);
        await route.continue({ headers: { 'x-route': 'routed' } });
      });
      const sent = (pathname: string) => gate.asked.get(pathname)?.map((headers) => [headers['x-route'], headers.authorization]);
      expect(await headingAt(engine, 'b4', `${gate.url}/landing`)).toBe('Through');
      expect(routed).toEqual(['/landing']);
      expect(sent('/landing')).toEqual([['routed', undefined], ['routed', AUTHORIZATION]]);
      await engine.session!.reset!(operation('b4'));
      gate.asked.clear();
      // The hop a redirect leads to is challenged at another credential origin, and is never routed.
      expect(await headingAt(engine, 'b4', through(`${gate.url.replace('127.0.0.1', 'localhost')}/landing`))).toBe('Through');
      expect(routed).toEqual(['/landing', '/hop']);
      expect(sent('/landing')).toEqual([['routed', undefined], ['routed', AUTHORIZATION]]);
    } finally {
      await shutdown(engine);
      await gate.close();
    }
  });

  it('runs a route once for a request the browser sends again with the credentials it holds for the realm', async () => {
    const gate = await startGate();
    const engine = web({ basicAuth: PROTECTED_CREDENTIAL });
    try {
      await boot(engine, gate, artifactsDir, 'b5');
      const browser = browserOf(engine, gate);
      const routed: string[] = [];
      // The override names no authorization header.
      await browser.route(/\/(api\/me|app\/data)$/, async (route) => {
        routed.push(new URL(route.request.url).pathname);
        await route.continue({ headers: { 'x-route': 'routed' } });
      });
      const sent = (pathname: string) => gate.asked.get(pathname)?.map((headers) => [headers['x-route'], headers.authorization]);
      const fetched = (pathname: string) => browser.evaluate(async (target) => (await fetch(target)).status, pathname);
      // The page's challenge is answered, and the browser keeps the credentials for the realm, under /app/.
      expect(await headingAt(engine, 'b5', `${gate.url}/app/page`)).toBe('Through');
      // Outside /app/ the request goes bare, and the browser answers its challenge from the realm itself, raising none.
      const [response, status] = await Promise.all([browser.waitForResponse('**/api/me'), fetched('/api/me')]);
      expect([status, response.status]).toEqual([200, 200]);
      expect(routed).toEqual(['/api/me']);
      expect(sent('/api/me')).toEqual([['routed', undefined], ['routed', AUTHORIZATION]]);
      // Inside it Chromium adds the credentials as the request goes. Firefox has them on the held request,
      // where the override leaves them out, so the gate challenges it and the driver answers.
      expect(await fetched('/app/data')).toBe(200);
      expect(routed).toEqual(['/api/me', '/app/data']);
      expect(sent('/app/data')).toEqual(onFirefox ? [['routed', undefined], ['routed', AUTHORIZATION]] : [['routed', AUTHORIZATION]]);
    } finally {
      await shutdown(engine);
      await gate.close();
    }
  });

  it('answers the challenge with a secrets.get() password the attempt resolves', async () => {
    const asked: string[] = [];
    const engine = web({ basicAuth: { username: PROTECTED_CREDENTIAL.username, password: secrets.get('previewPassword') } });
    try {
      await boot(engine, app, artifactsDir, 's1', async (secret) => {
        asked.push(secret.name);
        return PROTECTED_CREDENTIAL.password;
      });
      expect(await headingAt(engine, 's1', `${app.url}/protected`)).toBe('Protected');
      expect(asked).toEqual(['previewPassword']);
    } finally {
      await shutdown(engine);
    }
  });

  it('reports the configured user agent to the page, after a context reset too', async () => {
    const engine = web({ userAgent: 'Mozilla/5.0 e2e-probe' });
    try {
      await boot(engine, app, artifactsDir, 'u0');
      await engine.session!.open!(app.url, operation('u0'));
      const userAgent = () => browserOf(engine, app).evaluate(() => navigator.userAgent);
      expect(await userAgent()).toBe('Mozilla/5.0 e2e-probe');
      await engine.session!.reset!(operation('u0'));
      await engine.session!.open!(app.url, operation('u0'));
      expect(await userAgent()).toBe('Mozilla/5.0 e2e-probe');
    } finally {
      await shutdown(engine);
    }
  });

  it('runs the page in the configured locale and time zone, after a context reset too', async () => {
    const engine = web({ locale: 'de-DE', timezoneId: 'Asia/Tokyo' });
    const read = () =>
      browserOf(engine, app).evaluate(() => ({
        language: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offset: new Date('2026-01-01T00:00:00Z').getTimezoneOffset(),
      }));
    const expected = { language: 'de-DE', timeZone: 'Asia/Tokyo', offset: -540 };
    try {
      await boot(engine, app, artifactsDir, 'l0');
      await engine.session!.open!(app.url, operation('l0'));
      expect(await read()).toEqual(expected);
      await engine.session!.reset!(operation('l0'));
      await engine.session!.open!(app.url, operation('l0'));
      expect(await read()).toEqual(expected);
    } finally {
      await shutdown(engine);
    }
  });
});
