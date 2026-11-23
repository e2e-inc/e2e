/** The app under test is the target's: `web()` checks the target's `app` for what a browser needs. */

import { describe, expect, it } from 'vitest';
import { web } from '../../src/index.ts';

describe('web() and the target app', () => {
  it('needs app.url on the target, and refuses the fields of an installed device app', () => {
    const { validateApp } = web();
    const info = { targetName: 'chromium' };
    expect(() => validateApp!({ url: 'http://localhost:3000' }, info)).not.toThrow();
    expect(() => validateApp!({}, info)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('target "chromium" needs app.url') }),
    );
    for (const key of ['bundleId', 'appPath', 'launchArguments'] as const) {
      expect(() => validateApp!({ url: 'http://localhost:3000', [key]: key === 'launchArguments' ? ['-x'] : 'x' }, info)).toThrowError(
        expect.objectContaining({ message: `target "chromium" declares app.${key}, which describes an installed device app; a web() target opens app.url` }),
      );
    }
  });

  it('opens a file app.url in a local browser only, with no credentials to scope', () => {
    const info = { targetName: 'web' };
    const url = 'file:///tmp/site/index.html';
    const refused = (message: string) => expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining(message) });
    for (const browser of ['chromium', 'firefox', 'webkit'] as const) expect(() => web({ browser }).validateApp!({ url }, info)).not.toThrow();
    const hosted = { name: 'hosted', acquire: async () => ({ id: 's', cdpEndpoint: 'ws://localhost:9222' }), release: async () => undefined };
    expect(() => web({ browser: hosted }).validateApp!({ url }, info)).toThrowError(
      refused('target "web" opens a file app.url, which browser provider "hosted" cannot read'),
    );
    expect(() => web({ connect: { cdpEndpoint: () => 'ws://localhost:9222' } }).validateApp!({ url }, info)).toThrowError(
      refused('web({ connect }) attaches to a browser that may run on another machine'),
    );
    expect(() => web({ headers: { 'x-preview': 'synthetic' } }).validateApp!({ url }, info)).toThrowError(
      refused("web({ headers }) always goes to the app's origin, which a file does not have"),
    );
    // The scheme is read as the harness parses it: any case, and past leading whitespace.
    expect(() => web({ basicAuth: { username: 'user', password: 'synthetic' } }).validateApp!({ url: ' FILE:///tmp/site/index.html' }, info)).toThrowError(
      refused("web({ basicAuth }) always goes to the app's origin, which a file does not have"),
    );
    expect(() => web({ browser: hosted, headers: { 'x-preview': 'synthetic' } }).validateApp!({ url: 'http://localhost:3000' }, info)).not.toThrow();
  });

  it('takes the permissions its browser grants, and grants only', () => {
    const info = { targetName: 'web' };
    const url = 'http://localhost:3000';
    const refused = (message: string) => expect.objectContaining({ code: 'INVALID_CONFIG', message });
    expect(() => web().validateApp!({ url, permissions: { 'clipboard-read': 'grant', 'clipboard-write': 'grant' } }, info)).not.toThrow();
    expect(() => web({ browser: 'webkit' }).validateApp!({ url, permissions: { 'clipboard-read': 'grant' } }, info)).not.toThrow();
    expect(() => web({ browser: 'firefox' }).validateApp!({ url, permissions: { 'clipboard-read': 'grant' } }, info)).toThrowError(
      refused(expect.stringContaining('target "web" app.permissions on firefox has unknown key "clipboard-read"')),
    );
    expect(() => web().validateApp!({ url, permissions: { 'clipboard-wirte': 'grant' } }, info)).toThrowError(
      refused(expect.stringContaining('did you mean "clipboard-write"')),
    );
    for (const state of ['deny', 'reset'] as const) {
      expect(() => web().validateApp!({ url, permissions: { camera: state } }, info)).toThrowError(
        refused(`target "web" app.permissions.camera is ${state}, but a web() target only grants; leave the permission out instead`),
      );
    }
  });
});
