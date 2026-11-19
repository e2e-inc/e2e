/**
 * The body of a request a route holds, on both browsers: `route.fetch()`
 * sends upstream the exact bytes the page sent, text or not, and
 * `route.request.postData` is those bytes decoded as UTF-8. A body the
 * browser reports no bytes for is never sent short: `route.fetch()` refuses,
 * and `postData` is undefined. Chromium reports none for a form part that is
 * a file on disk, and for a streamed body; Firefox reads the file, and has
 * no streamed bodies.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../../src/fixture/types.ts';
import { bySelector, onFirefox, startWebSession, type WebSession } from '../helpers/web-session.ts';

/** One request `/record` received: its `Content-Type` and its body's bytes. */
interface Recorded {
  readonly type: string | undefined;
  readonly body: Buffer;
}

/** Bytes that are no UTF-8 text. */
const BINARY = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41]);
/** The file the page's form uploads from disk. */
const DISK_FILE = Buffer.from([0xff, 0x00, 0x44, 0x49, 0x53, 0x4b]);
/** A body larger than any inline limit of the protocols: 300 000 bytes. */
const LARGE = Buffer.alloc(300_000, 0x42);

/** A multipart body of a `note` field and a `file` part, as both browsers encode a form with `boundary`. */
function multipart(boundary: string, note: string, file: { name: string; type: string; bytes: Buffer }): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\n${note}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

/** The boundary a multipart `Content-Type` names. */
const boundaryOf = (type: string | undefined): string => /boundary=(.+)$/.exec(type ?? '')?.[1] ?? '';

describe('route.fetch and the request body', () => {
  const uploads = mkdtempSync(path.join(tmpdir(), 'e2e-route-bodies-'));
  /** Named `.txt` so every platform gives its form part the same `Content-Type`. */
  const diskFile = path.join(uploads, 'disk.txt');
  let session: WebSession;
  let browser: Browser;
  const recorded: Recorded[] = [];

  beforeAll(async () => {
    writeFileSync(diskFile, DISK_FILE);
    session = await startWebSession({ timeoutMs: 10_000, startAttempt: false });
    session.serve('/page', `<!doctype html><title>Bodies</title><h1>Bodies</h1>
      <form id="upload"><input name="note" value="from disk"><input type="file" name="file"></form>`);
    session.serve('/record', (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        recorded.push({ type: request.headers['content-type'], body: Buffer.concat(chunks) });
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(`recorded ${String(recorded.length)}`);
      });
    });
  });

  beforeEach(async () => {
    recorded.length = 0;
    await session.startAttempt();
    browser = session.browser;
    await browser.goto('/page');
  });

  afterEach(async () => {
    await session.endAttempt();
  });

  afterAll(async () => {
    try {
      await session.close();
    } finally {
      rmSync(uploads, { recursive: true, force: true });
    }
  });

  /** What a route on `/record` saw of each request: its `postData`, and the failure of its `route.fetch()` if it had one. */
  interface Seen {
    readonly postData: string | undefined;
    readonly refusal?: unknown;
  }

  /** Routes `/record` through `route.fetch()`, answering with what the server said, or `refused` when the fetch failed. */
  const replayThroughRoute = async (): Promise<Seen[]> => {
    const seen: Seen[] = [];
    await browser.route('**/record', async (route) => {
      const { postData } = route.request;
      try {
        const upstream = await route.fetch();
        seen.push({ postData });
        await route.fulfill({ status: upstream.status, body: await upstream.text() });
      } catch (refusal) {
        seen.push({ postData, refusal });
        await route.fulfill({ status: 599, body: 'refused' });
      }
    });
    return seen;
  };

  /** POSTs to `/record` from the page with the body the page-side expression `body` builds; resolves with the response text, or the fetch's failure. */
  const post = (body: string, init = ''): Promise<string> => browser.evaluate(
    `fetch('/record', { method: 'POST', body: ${body}${init} }).then((reply) => reply.text(), (error) => 'failed: ' + String(error))`,
  ) as Promise<string>;

  /** Puts the file on disk in the page's form. */
  const pickDiskFile = (): Promise<void> => session.act(bySelector('input[type=file]'), { kind: 'setInputFiles', paths: [diskFile] });

  /** A body the browser reports whole, and its bytes. */
  const WHOLE: readonly (readonly [name: string, body: string, bytes: Buffer])[] = [
    ['text', `'hello'`, Buffer.from('hello')],
    ['text that is not ASCII', `'zażółć 🙂'`, Buffer.from('zażółć 🙂')],
    ['a binary Uint8Array', `new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41])`, BINARY],
    ['an ArrayBuffer', `new Uint8Array([104, 105]).buffer`, Buffer.from('hi')],
    ['a Blob', `new Blob(['BLOBDATA'])`, Buffer.from('BLOBDATA')],
    ['a Blob of binary bytes', `new Blob([new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41])])`, BINARY],
    ['a 300 000 byte Blob', `new Blob([new Uint8Array(300000).fill(0x42)])`, LARGE],
    ['URLSearchParams', `new URLSearchParams({ a: '1', b: 'ü' })`, Buffer.from('a=1&b=%C3%BC')],
  ];

  it.each(WHOLE)('replays %s with the exact bytes, and reads them as postData', async (_name, body, bytes) => {
    const seen = await replayThroughRoute();
    expect(await post(body)).toBe('recorded 1');
    expect(recorded.map((request) => request.body.toString('hex'))).toEqual([bytes.toString('hex')]);
    expect(seen).toEqual([{ postData: bytes.toString() }]);
  });

  it('reads a binary body as postData with U+FFFD for each byte that is no UTF-8', async () => {
    const seen = await replayThroughRoute();
    await post(`new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41])`);
    expect(seen).toEqual([{ postData: '��\u0000�A' }]);
  });

  it('replays a multipart form with a file part with the exact bytes', async () => {
    const seen = await replayThroughRoute();
    const form = `(() => { const form = new FormData(); form.append('note', 'two words'); form.append('file', new File([new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41])], 'a.bin', { type: 'application/octet-stream' })); return form; })()`;
    expect(await post(form)).toBe('recorded 1');
    expect(recorded).toHaveLength(1);
    const expected = multipart(boundaryOf(recorded[0]!.type), 'two words', { name: 'a.bin', type: 'application/octet-stream', bytes: BINARY });
    expect(recorded[0]!.body.toString('hex')).toBe(expected.toString('hex'));
    expect(seen).toEqual([{ postData: expected.toString() }]);
  });

  it('replays a body that is one file from disk with the exact bytes', async () => {
    const seen = await replayThroughRoute();
    await pickDiskFile();
    expect(await post(`document.querySelector('input[type=file]').files[0]`)).toBe('recorded 1');
    expect(recorded.map((request) => request.body.toString('hex'))).toEqual([DISK_FILE.toString('hex')]);
    expect(seen).toEqual([{ postData: DISK_FILE.toString() }]);
  });

  it('replays a multipart form with a file from disk on Firefox, and refuses on Chromium, which reports no bytes for the file', async () => {
    const seen = await replayThroughRoute();
    await pickDiskFile();
    const outcome = await post(`new FormData(document.querySelector('#upload'))`);
    if (onFirefox) {
      expect(outcome).toBe('recorded 1');
      const [request] = recorded;
      const expected = multipart(boundaryOf(request!.type), 'from disk', { name: 'disk.txt', type: 'text/plain', bytes: DISK_FILE });
      expect(request!.body.toString('hex')).toBe(expected.toString('hex'));
      expect(seen).toEqual([{ postData: expected.toString() }]);
      return;
    }
    expect(outcome).toBe('refused');
    expect(recorded).toEqual([]);
    expect(seen).toEqual([{
      postData: undefined,
      refusal: expect.objectContaining({
        code: 'ACTION_FAILED',
        message: 'route.fetch: the browser reports no bytes for a part of the request body (a file on disk, or a stream), so the request cannot be replayed',
      }),
    }]);
  });

  it('sends the form with its file from disk when the route lets the request go on', async () => {
    const methods: string[] = [];
    await browser.route('**/record', async (route) => {
      methods.push(route.request.method);
      await route.continue();
    });
    await pickDiskFile();
    expect(await post(`new FormData(document.querySelector('#upload'))`)).toBe('recorded 1');
    const [request] = recorded;
    expect(request!.body.toString('hex')).toBe(multipart(boundaryOf(request!.type), 'from disk', { name: 'disk.txt', type: 'text/plain', bytes: DISK_FILE }).toString('hex'));
    expect(methods).toEqual(['POST']);
  });

  it('refuses to replay a streamed body on Chromium; Firefox has none, and replays only what it sends in the stream\'s place', async () => {
    const seen = await replayThroughRoute();
    const outcome = await post(`new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('STREAM')); controller.close(); } })`, `, duplex: 'half'`);
    if (onFirefox) {
      // Firefox sends the stream as the text of its name, or fails the fetch itself before any route: whichever, the server gets what the route was handed.
      expect(recorded.map((request) => request.body.toString())).toEqual(seen.map((one) => one.postData));
      expect(seen.filter((one) => 'refusal' in one)).toEqual([]);
      return;
    }
    expect(outcome).toBe('refused');
    expect(recorded).toEqual([]);
    expect(seen).toEqual([{ postData: undefined, refusal: expect.objectContaining({ code: 'ACTION_FAILED', message: expect.stringContaining('reports no bytes for a part of the request body') }) }]);
  });

  it.each([['an empty string', `''`], ['an empty Blob', `new Blob([])`]])('replays %s as a POST with no bytes', async (_name, body) => {
    const seen = await replayThroughRoute();
    expect(await post(body)).toBe('recorded 1');
    expect(recorded.map((request) => request.body.length)).toEqual([0]);
    expect(seen.map((one) => 'refusal' in one)).toEqual([false]);
  });

  it('replays a POST without a body as one, with no postData', async () => {
    const seen = await replayThroughRoute();
    expect(await browser.evaluate(() => fetch('/record', { method: 'POST' }).then((reply) => reply.text()))).toBe('recorded 1');
    expect(recorded.map((request) => request.body.length)).toEqual([0]);
    expect(seen).toEqual([{ postData: undefined }]);
  });

  it('replays an XMLHttpRequest body of bytes with the exact bytes', async () => {
    const seen = await replayThroughRoute();
    const reply = await browser.evaluate(() => new Promise<string>((resolve) => {
      const request = new XMLHttpRequest();
      request.open('POST', '/record');
      request.addEventListener('loadend', () => resolve(request.responseText));
      request.send(new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x41]));
    }));
    expect(reply).toBe('recorded 1');
    expect(recorded.map((request) => request.body.toString('hex'))).toEqual([BINARY.toString('hex')]);
    expect(seen).toEqual([{ postData: BINARY.toString() }]);
  });
});
