import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPinned, pinnedExecutable } from '../../src/binary.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the pinned agent-desktop', () => {
  it('lives in the OS cache, never in the replay cache E2E_CACHE_DIR names', () => {
    const env = { HOME: '/home/ada', USERPROFILE: '/home/ada', XDG_CACHE_HOME: '/home/ada/.cache', LOCALAPPDATA: '/home/ada/local' };
    expect(pinnedExecutable({ ...env, E2E_CACHE_DIR: '.e2e/cache' })).toBe(pinnedExecutable(env));
    expect(pinnedExecutable(env)).toMatch(/^\/home\/ada\/.*[\\/]e2e[\\/]/);
  });

  it('reports a failed download as AGENT_DESKTOP_INSTALL_FAILED', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const env = { HOME: '/nonexistent', USERPROFILE: '/nonexistent', XDG_CACHE_HOME: '/nonexistent/cache', LOCALAPPDATA: '/nonexistent/local' };
    await expect(installPinned(env, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'AGENT_DESKTOP_INSTALL_FAILED' });
  });
});
