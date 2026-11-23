/** How a target resolves when its `app.url` is a file: no host, so no site, origin, port, or readiness poll. */

import { describe, expect, it } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { checkTargetApp, engineAppInfo, resolveTargetApp, type ResolvedApp } from '@e2e-dev/core/lib/config/app';

const url = 'file:///tmp/e2e-file-app/site/index.html';

/** The app a target named `web` resolves to from what its config declares. */
const resolve = (declared: object): ResolvedApp => resolveTargetApp('web', checkTargetApp('web', createFakeEngine().engine, declared), '/tmp/project');

describe('a file app.url', () => {
  it('resolves with no site or origin, as a test environment, identified by the file', () => {
    const app = resolve({ url });
    expect(app.base?.href).toBe(url);
    expect(app.site).toBeUndefined();
    expect(app.environment).toBe('test');
    expect(app.identity).toBe(url);
    expect(app.portRequest).toBeUndefined();
    expect(engineAppInfo(app)).toEqual({});
  });

  it('keeps the origin and site of an http app', () => {
    const app = resolve({ url: 'https://app.example.com/shop' });
    expect(engineAppInfo(app)).toEqual({ origin: 'https://app.example.com', site: 'example.com' });
    expect(app.identity).toBe('https://app.example.com/shop');
  });

  it('needs a readyUrl beside a command, since a file answers no poll', () => {
    const command = { executable: 'npm', args: ['run', 'api'] };
    expect(() => resolve({ url, command })).toThrowError(
      expect.objectContaining({ code: 'APP_URL_REQUIRED', message: expect.stringContaining('a file answers no readiness poll: declare app.readyUrl') }),
    );
    expect(resolve({ url, command, readyUrl: 'http://localhost:4000/health' }).readyUrl).toBe('http://localhost:4000/health');
  });

  it('refuses {port} in a command, having no port to give', () => {
    expect(() => resolve({ url, readyUrl: 'http://localhost:4000', command: { executable: 'serve', args: ['-p', '{port}'] } })).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG' }),
    );
  });
});
