import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PORT = 4790 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server: ChildProcess;

before(async () => {
  server = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'server.ts'), '--port', String(PORT), '--out', join(process.env['TEMP'] ?? '/tmp', `viewer-test-${PORT}`)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await once(server.stdout!, 'data');
});

after(() => {
  server.kill();
});

/** The status and JSON body of a request to the viewer. */
async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test('lists the locale folders and names a default', async () => {
  const { status, body } = await call('/api/locales');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body['locales']) && body['locales'].length > 0);
  assert.equal(typeof body['default'], 'string');
});

test('refuses a request that names another origin', async () => {
  const { status } = await call('/api/locales', { headers: { origin: 'https://evil.example' } });
  assert.equal(status, 403);
});

test('refuses a page path that leaves the docs folder', async () => {
  const { body } = await call('/api/locales');
  const locale = String((body['locales'] as string[])[0]);
  const { status } = await call(`/api/file?locale=${locale}&path=${encodeURIComponent('../README.md')}`);
  assert.equal(status, 400);
});

test('answers 404, not 500, for a page the locale has not translated', async () => {
  const { body } = await call('/api/locales');
  const locale = String((body['locales'] as string[])[0]);
  const { status } = await call(`/api/file?locale=${locale}&path=${encodeURIComponent('no-such-page.mdx')}`);
  assert.equal(status, 404);
});

test('findings must be posted as JSON', async () => {
  const { status } = await call('/api/findings', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(status, 415);
});
