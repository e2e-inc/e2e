import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { connectBidiOverCdp } from '../../../src/driver/launch.ts';
import { launchRemoteChrome, tearDownRemote } from '../../helpers/cdp-host.ts';

/** A TCP listener exposes a numeric port rather than a pipe path. */
function isTcpAddress(value: ReturnType<Server['address']>): value is AddressInfo {
  return value !== null && typeof value !== 'string';
}

/** Binds the test's HTTP server to a free loopback port. */
async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  if (!isTcpAddress(address)) throw new Error('test server has no TCP address');

  return `http://127.0.0.1:${address.port}`;
}

/** Closes HTTP connections even when an assertion fails. */
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
}

it('sends the headers with the CDP discovery, and never with the page\'s requests', async () => {
  const remote = await launchRemoteChrome();
  const handshakeHeaders: (string | undefined)[] = [];
  const pageHeaders: (string | undefined)[] = [];

  const server = createServer((request, response) => {
    if (request.url?.startsWith('/devtools/')) {
      handshakeHeaders.push(request.headers.authorization);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ webSocketDebuggerUrl: remote.endpoint }));
    } else {
      pageHeaders.push(request.headers.authorization);
      response.end('<title>Test app</title>');
    }
  });

  try {
    const url = await listen(server);
    const browser = await connectBidiOverCdp({ endpoint: `${url}/devtools`, headers: { Authorization: 'Bearer synthetic-token' } }, 5_000, new AbortController().signal);

    try {
      const { context } = await browser.connection.send('browsingContext.create', { type: 'tab' });
      await browser.connection.send('browsingContext.navigate', { context, url: `${url}/app`, wait: 'complete' });
      expect(handshakeHeaders).toEqual(['Bearer synthetic-token']);
      expect(pageHeaders.length).toBeGreaterThan(0);
      expect(pageHeaders.every((header) => header === undefined)).toBe(true);
    } finally {
      await browser.close();
    }
  } finally {
    await tearDownRemote({ chrome: remote, closes: [() => close(server)] });
  }
});

it.each([
  'Unauthorized',
  'Authorization Bearer synthetic-token, token synthetic-token',
])('sends the headers with the WebSocket upgrade, and keeps them out of its rejection %s', async (reason) => {
  const upgradeHeaders: (string | undefined)[] = [];
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    upgradeHeaders.push(request.headers.authorization);
    socket.end(`HTTP/1.1 401 ${reason}\r\nContent-Length: 0\r\n\r\n`);
  });

  try {
    const endpoint = (await listen(server)).replace('http:', 'ws:');
    const failure = await connectBidiOverCdp({ endpoint, headers: { Authorization: 'Bearer synthetic-token' } }, 5_000, new AbortController().signal).catch((error: unknown) => error);
    expect(upgradeHeaders.length).toBeGreaterThan(0);
    expect(upgradeHeaders.every((header) => header === 'Bearer synthetic-token')).toBe(true);
    expect(failure).toMatchObject({ code: 'ENGINE_FAILURE', message: 'BiDi attach over CDP failed; check the endpoint, handshake headers, and connection timeout' });
    expect((failure as Error).stack).not.toContain('synthetic-token');
    expect((failure as Error).cause).toBeUndefined();
  } finally {
    await close(server);
  }
});
