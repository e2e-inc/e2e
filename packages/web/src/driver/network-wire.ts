/**
 * BiDi's network values as the driver reads and writes them: a header list
 * as a record and back, a bytes value as text or a buffer, whether a request
 * carries a body, and a URL without its fragment.
 */

import type { Network } from 'webdriver-bidi-protocol';

/** BiDi headers as a record, names lowercased; a repeated name keeps its values joined, as Playwright reports them. */
export function headerRecord(headers: readonly Network.Header[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.toLowerCase();
    const value = bytesText(header.value);
    out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`;
  }
  return out;
}

/** A header record as BiDi headers. */
export function wireHeaders(headers: Readonly<Record<string, string>>): Network.Header[] {
  return Object.entries(headers).flatMap(([name, value]) => (name.toLowerCase() === 'set-cookie' ? value.split('\n') : [value]).map((one) => ({ name, value: { type: 'string' as const, value: one } })));
}

/** A BiDi bytes value as text. */
export function bytesText(value: Network.BytesValue): string {
  return value.type === 'string' ? value.value : Buffer.from(value.value, 'base64').toString();
}

/** A BiDi bytes value as a buffer. */
export function bytesOf(bytes: Network.BytesValue): Buffer {
  return bytes.type === 'string' ? Buffer.from(bytes.value) : Buffer.from(bytes.value, 'base64');
}

/** Whether `request` carries a body a collector may have kept. */
export function hasBody(request: Network.RequestData): boolean {
  return request.bodySize !== 0 && !(request.bodySize === null && ['GET', 'HEAD'].includes(request.method));
}

/** A URL without its fragment, which no request carries to the server and Playwright never reports. */
export function stripHash(url: string): string {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}
