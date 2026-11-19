/**
 * The WebSocket the driver reaches a browser over: Firefox's BiDi endpoint,
 * and Chrome's CDP endpoint from the mapper's process. It is `ws`, not
 * Node's own client, for two faults of the one Node 22 ships (undici 6):
 *
 * - It always offers compression, which Chrome takes, and drops the
 *   connection on a message that inflates past 4 MB: a screenshot, a
 *   response body, a posted file.
 * - It masks every frame after a process's 4096th with zeros, and Firefox
 *   closes a connection that sends one, then every new one of the process.
 */

import { WebSocket, type RawData } from 'ws';

/**
 * The largest message taken from a browser, the limit Playwright's
 * transports set: a screenshot or a body comes whole in one message.
 */
const MAX_MESSAGE = 256 * 1024 * 1024;

/** Opens a WebSocket to the browser at `url`, with `headers` on its upgrade request, offering no compression. */
export function browserSocket(url: string, headers?: Readonly<Record<string, string>>): WebSocket {
  return new WebSocket(url, { headers: { ...headers }, perMessageDeflate: false, maxPayload: MAX_MESSAGE });
}

/** A message as text; `ws` hands a text message over as its bytes. */
export function textOf(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString('utf8');
}
