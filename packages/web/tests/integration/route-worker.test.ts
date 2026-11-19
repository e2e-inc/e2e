/**
 * A dedicated worker's request while a route is registered, on both
 * browsers: the server receives the exact bytes the worker posted and the
 * worker gets the response, whether the route lets the request go on,
 * replays it with `route.fetch()`, or matches another URL, and a redirect of
 * the worker's request is held like its first hop. Chromium pauses a
 * worker's request on the page's CDP session and announces it on the
 * worker's, the later the larger its body, so the sizes cover both orders.
 */

import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser, WebRoute } from '../../src/fixture/types.ts';
import { startWebSession, type WebSession } from '../helpers/web-session.ts';

type BodyKind = 'text' | 'binary';

/** What a worker fetches: a GET of `path`, or a POST of `size` bytes of `kind` to it. */
interface WorkerFetch {
  readonly path: string;
  readonly kind?: BodyKind;
  readonly size?: number;
}

/** The body a worker posts: `size` bytes of ASCII text, or of bytes that are no UTF-8 text. Runs in the worker too, from its source. */
const bodyOf = (kind: BodyKind, size: number): string | Uint8Array => (kind === 'text'
  ? 'a worker posts 0123456789 '.repeat(Math.ceil(size / 26)).slice(0, size)
  : Uint8Array.from({ length: size }, (_, index) => (index * 31 + 7) % 256));

/** The length and digest of `bytes`, which tell two large bodies apart in a line. */
const summary = (bytes: Uint8Array): { length: number; sha256: string } => ({ length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

const SIZES = [['1 KB', 1024], ['64 KB', 65_536], ['1 MB', 1_048_576]] as const;
const KINDS = ['text', 'binary'] as const;
const BODIES = SIZES.flatMap(([label, size]) => KINDS.map((kind) => [`${label} of ${kind}`, kind, size] as const));

describe('a route while a dedicated worker fetches', () => {
  let session: WebSession;
  let browser: Browser;
  /** The body of every request `/record` received. */
  const recorded: Buffer[] = [];
  /** Every request `/hop` and `/record` received: its method, its path, and its `x-route` header. */
  const arrived: string[] = [];

  beforeAll(async () => {
    session = await startWebSession({ timeoutMs: 10_000, startAttempt: false });
    session.serve('/page', '<!doctype html><title>Worker</title><h1>Worker</h1>');
    session.serve('/worker.js', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(`const bodyOf = ${bodyOf.toString()};
        const asked = new URLSearchParams(location.search);
        const kind = asked.get('kind');
        fetch(asked.get('path'), kind === null ? {} : { method: 'POST', body: bodyOf(kind, Number(asked.get('size'))) })
          .then(async (reply) => postMessage(String(reply.status) + ' ' + await reply.text()), (error) => postMessage('failed: ' + String(error)));`);
    });
    session.serve('/record', (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        recorded.push(Buffer.concat(chunks));
        arrived.push(`${String(request.method)} /record x-route=${String(request.headers['x-route'])}`);
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(`recorded ${String(recorded.at(-1)!.length)}`);
      });
    });
    session.serve('/hop', (request, response) => {
      request.resume();
      request.on('end', () => {
        arrived.push(`${String(request.method)} /hop x-route=${String(request.headers['x-route'])}`);
        response.writeHead(307, { location: '/record' });
        response.end();
      });
    });
  });

  beforeEach(async () => {
    recorded.length = 0;
    arrived.length = 0;
    await session.startAttempt();
    browser = session.browser;
    await browser.goto('/page');
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    await session.close();
  });

  /** Starts a worker that makes the request its URL names, and resolves with what the worker got: the status and the response text, or the fetch's failure. */
  const fetchFromWorker = ({ path, kind, size }: WorkerFetch): Promise<string> => browser.evaluate(
    (asked) => new Promise<string>((resolve) => {
      new Worker(`/worker.js?${asked}`).addEventListener('message', ({ data }) => resolve(String(data)));
    }),
    new URLSearchParams({ path, ...(kind === undefined ? {} : { kind, size: String(size) }) }).toString(),
  );

  /** A way a registered route treats the worker's POST: the URL it matches, what it does with a request, and how many it is handed. */
  const ROUTES: readonly (readonly [name: string, pattern: string, handle: (route: WebRoute) => Promise<void>, handed: number])[] = [
    ['lets the request go on', '**/record', (route) => route.continue(), 1],
    ['replays the request with route.fetch()', '**/record', async (route) => {
      const upstream = await route.fetch();
      await route.fulfill({ status: upstream.status, body: await upstream.text() });
    }, 1],
    ['matches another URL', '**/elsewhere', (route) => route.continue(), 0],
  ];

  describe.each(ROUTES)('with a route that %s', (_name, pattern, handle, handed) => {
    it.each(BODIES)('sends a POST of %s to the server, and the worker gets the response', async (_label, kind, size) => {
      const methods: string[] = [];
      await browser.route(pattern, async (route) => {
        methods.push(route.request.method);
        await handle(route);
      });

      const outcome = await fetchFromWorker({ path: '/record', kind, size });

      expect(outcome).toBe(`200 recorded ${String(size)}`);
      expect(recorded.map(summary)).toEqual([summary(Buffer.from(bodyOf(kind, size)))]);
      expect(methods).toEqual(Array.from({ length: handed }, () => 'POST'));
    });
  });

  it('hands the route a GET, and the worker gets the response', async () => {
    const methods: string[] = [];
    await browser.route('**/record', async (route) => {
      methods.push(route.request.method);
      await route.continue();
    });

    expect(await fetchFromWorker({ path: '/record' })).toBe('200 recorded 0');
    expect(methods).toEqual(['GET']);
  });

  it('sends the headers a route set on the hop a redirect of the POST leads to, with the body, and reports that hop\'s response', async () => {
    await browser.route('**/hop', (route) => route.continue({ headers: { ...route.request.headers, 'x-route': 'set' } }));
    const landed = browser.waitForResponse('**/record');

    const outcome = await fetchFromWorker({ path: '/hop', kind: 'binary', size: 65_536 });

    expect(outcome).toBe('200 recorded 65536');
    expect((await landed).status).toBe(200);
    expect(recorded.map(summary)).toEqual([summary(Buffer.from(bodyOf('binary', 65_536)))]);
    expect(arrived).toEqual(['POST /hop x-route=set', 'POST /record x-route=set']);
  });
});
