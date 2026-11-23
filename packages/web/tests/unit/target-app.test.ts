/** The app under test is the target's: `web()` checks the target's `app` for what a browser needs. */

import { describe, expect, it } from 'vitest';
import { web } from '../../src/index.ts';
import { grantedPermissions, grantPermissions } from '../../src/permissions.ts';

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

  it('takes \'all\' on every browser, granting each permission that browser grants', () => {
    for (const browser of ['chromium', 'firefox', 'webkit'] as const) {
      expect(() => web({ browser }).validateApp!({ url: 'http://localhost:3000', allPermissions: true }, { targetName: 'web' })).not.toThrow();
    }
    expect(grantedPermissions('firefox', { allPermissions: true })).toEqual(['geolocation', 'local-network-access', 'notifications', 'persistent-storage', 'push', 'screen-wake-lock']);
    expect(grantedPermissions('chromium', { allPermissions: true })).toContain('clipboard-read');
    expect(grantedPermissions('webkit', { permissions: { camera: 'grant' } })).toEqual(['camera']);
    expect(grantedPermissions('webkit', {})).toEqual([]);
    expect(web().grantsAllPermissions).toBe(true);
  });

  it("leaves out, for 'all' only, a permission an older browser refuses as unknown, and grants the rest", async () => {
    /**
     * A context on a browser that knows every type but `localNetworkAccess`, the way Chrome 134 answers over
     * CDP. Like Playwright's, it adds the names to the context's grants before it sends them, so a refused
     * name stays until the grants are cleared.
     */
    const olderChrome = () => {
      let held: string[] = [];
      const sent: string[][] = [];
      return {
        sent,
        async grantPermissions(names: string[]) {
          held = [...new Set([...held, ...names])];
          if (held.includes('local-network-access')) throw new Error('browserContext.grantPermissions: Unknown permission type: localNetworkAccess');
          sent.push(held);
        },
        async clearPermissions() {
          held = [];
        },
      };
    };
    const all = grantedPermissions('chromium', { allPermissions: true });
    const context = olderChrome();
    await grantPermissions(context, all, true);
    expect(context.sent).toEqual([all.filter((name) => name !== 'local-network-access')]);
    // A named grant keeps the browser's refusal: the user can leave the name out.
    await expect(grantPermissions(olderChrome(), ['geolocation', 'local-network-access'], false)).rejects.toThrow('Unknown permission type: localNetworkAccess');
    // Any other failure is not an unknown name to skip.
    const broken = { grantPermissions: async () => { throw new Error('Target page, context or browser has been closed'); }, clearPermissions: async () => {} };
    await expect(grantPermissions(broken, all, true)).rejects.toThrow('has been closed');
  });
});
