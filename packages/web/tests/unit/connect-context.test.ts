/**
 * `web({ connect: { context } })` at config load: the values it takes, what
 * it cannot be combined with, and what the engine declares for `'existing'`,
 * where an attempt drives the page the browser already shows.
 */

import { describe, expect, it } from 'vitest';
import { web, type BrowserProvider, type WebConnectOptions } from '../../src/index.ts';

const cdpEndpoint = (): string => 'ws://localhost:0';

/** `web({ connect })` with `context` as a config file could write it, any value included. */
function connectWith(context: unknown): () => unknown {
  return () => web({ connect: { cdpEndpoint, context } as WebConnectOptions });
}

describe("web({ connect: { context } })", () => {
  it('takes "new", "existing", and nothing', () => {
    expect(connectWith('new')).not.toThrow();
    expect(connectWith('existing')).not.toThrow();
    expect(() => web({ connect: { cdpEndpoint } })).not.toThrow();
  });

  it('refuses any other value as INVALID_CONFIG, naming the two it takes', () => {
    const refused = (got: string) => expect.objectContaining({ code: 'INVALID_CONFIG', message: `web({ connect: { context } }) must be "new" or "existing", got ${got}` });
    expect(connectWith('adopt')).toThrow(refused('"adopt"'));
    expect(connectWith('')).toThrow(refused('""'));
    expect(connectWith(true)).toThrow(refused('a boolean'));
    expect(connectWith(null)).toThrow(refused('null'));
    expect(connectWith({ existing: true })).toThrow(refused('an object'));
  });

  it('still needs cdpEndpoint, and still refuses a browser provider and a browser other than chromium', () => {
    const provider: BrowserProvider = { name: 'toy-cloud', acquire: async () => ({ id: 'lease', cdpEndpoint: 'wss://lease.example' }), release: async () => undefined };
    expect(() => web({ connect: { context: 'existing' } as WebConnectOptions })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('requires cdpEndpoint') }));
    expect(() => web({ browser: provider, connect: { cdpEndpoint, context: 'existing' } })).toThrow(expect.objectContaining({
      code: 'INVALID_CONFIG',
      message: 'web({ browser, connect }) names two browser sources; browser provider "toy-cloud" leases its own browsers, so remove connect',
    }));
    expect(() => web({ browser: 'firefox', connect: { cdpEndpoint, context: 'existing' } })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('chromium-only') }));
  });

  it('serves one worker with "existing", since one endpoint shows one page, and as many as the run allows otherwise', () => {
    expect(web({ connect: { cdpEndpoint, context: 'existing' } }).workers).toBe(1);
    expect(web({ connect: { cdpEndpoint, context: 'new' } }).workers).toBeUndefined();
    expect(web({ connect: { cdpEndpoint } }).workers).toBeUndefined();
  });

  it('still needs app.url with "existing": app.open() navigates the page the browser shows', () => {
    const { validateApp } = web({ connect: { cdpEndpoint, context: 'existing' } });
    expect(() => validateApp!({ url: 'http://localhost:3000' }, { targetName: 'electron' })).not.toThrow();
    expect(() => validateApp!({}, { targetName: 'electron' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('target "electron" needs app.url') }));
  });

  it('keeps no saved session with "existing", and says why app.clearState() cannot run', async () => {
    const existing = web({ connect: { cdpEndpoint, context: 'existing' } });
    expect(existing.state).toBeUndefined();
    await expect(existing.session!.reset!({} as never)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: "app.clearState() is unavailable with web({ connect: { context: 'existing' } }): it replaces the browser context, and the attempt drives the browser's own",
    });
    expect(web({ connect: { cdpEndpoint } }).state).toBeDefined();
  });
});
