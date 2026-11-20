import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPinned, pinnedExecutable } from '../../src/binary.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A release archive of its own, with its digest as the pinned one for every target. */
function release(home: string): { bytes: Buffer; digest: string; digests: Record<string, string> } {
  const files = path.join(home, 'release');
  mkdirSync(files);
  for (const name of ['agent-desktop', 'agent-desktop-macos-helper']) writeFileSync(path.join(files, name), '#!/bin/sh\necho 1.3.1\n', { mode: 0o755 });
  const archive = path.join(home, 'release.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', files, '.']);
  const bytes = readFileSync(archive);
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { bytes, digest, digests: Object.fromEntries(['aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu'].map((target) => [target, digest])) };
}

describe('the pinned agent-desktop', () => {
  it('lives in the OS cache, never in the replay cache E2E_CACHE_DIR names', () => {
    const env = { HOME: '/home/ada', USERPROFILE: '/home/ada', XDG_CACHE_HOME: '/home/ada/.cache', LOCALAPPDATA: '/home/ada/local' };
    expect(pinnedExecutable({ ...env, E2E_CACHE_DIR: '.e2e/cache' })).toBe(pinnedExecutable(env));
    expect(pinnedExecutable(env)).toMatch(/^\/home\/ada\/.*[\\/]e2e[\\/]/);
  });

  it('refuses an archive whose SHA-256 is not the pinned one, and caches nothing', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
    const env = { HOME: '/nonexistent', USERPROFILE: '/nonexistent', XDG_CACHE_HOME: '/nonexistent/cache', LOCALAPPDATA: '/nonexistent/local' };
    await expect(installPinned(env, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'AGENT_DESKTOP_INSTALL_FAILED', message: expect.stringMatching(/refusing to unpack/) });
    expect(existsSync(pinnedExecutable(env)!)).toBe(false);
  });

  it('downloads again over a cache entry no verified unpack stamped', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      const executable = pinnedExecutable(env)!;
      mkdirSync(path.dirname(executable), { recursive: true });
      writeFileSync(executable, '#!/bin/sh\n');
      chmodSync(executable, 0o755);
      let fetched = 0;
      vi.stubGlobal('fetch', () => {
        fetched += 1;
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
      });
      await expect(installPinned(env, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'AGENT_DESKTOP_INSTALL_FAILED' });
      expect(fetched).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('unpacks a checked archive into the cache once, however many runs install it at the same time', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const { bytes, digest, digests } = release(home);
      let fetched = 0;
      vi.stubGlobal('fetch', () => {
        fetched += 1;
        return Promise.resolve(new Response(new Uint8Array(bytes)));
      });
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      const install = () => installPinned(env, new AbortController().signal, () => undefined, digests);
      const [first, second] = await Promise.all([install(), install()]);
      expect(first).toBe(pinnedExecutable(env));
      expect(second).toBe(first);
      expect(execFileSync(first, { encoding: 'utf8' }).trim()).toBe('1.3.1');
      expect(readFileSync(path.join(path.dirname(first), '.verified'), 'utf8')).toBe(digest);
      // Nothing but the entry is left beside it: no staging directory, no stale copy.
      expect(readdirSync(path.dirname(path.dirname(first)))).toEqual([path.basename(path.dirname(first))]);
      // A whole, checked entry is used as it is.
      const before = fetched;
      await install();
      expect(fetched).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('replaces a damaged cache entry with a checked unpack', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const { bytes, digest, digests } = release(home);
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array(bytes))));
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      // Stamped, but its executable lost: what a cleaner that deleted one file leaves.
      const entry = path.dirname(pinnedExecutable(env)!);
      mkdirSync(entry, { recursive: true });
      writeFileSync(path.join(entry, '.verified'), digest);
      const executable = await installPinned(env, new AbortController().signal, () => undefined, digests);
      expect(execFileSync(executable, { encoding: 'utf8' }).trim()).toBe('1.3.1');
      expect(readdirSync(path.dirname(entry))).toEqual([path.basename(entry)]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('repairs a damaged entry once when two runs repair it at the same time, and leaves no lock', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const { bytes, digest, digests } = release(home);
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array(bytes))));
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      const entry = path.dirname(pinnedExecutable(env)!);
      mkdirSync(entry, { recursive: true });
      writeFileSync(path.join(entry, '.verified'), digest);
      const install = () => installPinned(env, new AbortController().signal, () => undefined, digests);
      const [first] = await Promise.all([install(), install(), install()]);
      expect(execFileSync(first, { encoding: 'utf8' }).trim()).toBe('1.3.1');
      expect(readdirSync(path.dirname(entry))).toEqual([path.basename(entry)]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('takes over the lock a killed run left on the cache entry', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const { bytes, digest, digests } = release(home);
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array(bytes))));
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      const entry = path.dirname(pinnedExecutable(env)!);
      mkdirSync(entry, { recursive: true });
      writeFileSync(path.join(entry, '.verified'), digest);
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      mkdirSync(`${entry}.lock`);
      writeFileSync(path.join(`${entry}.lock`, 'owner'), String(dead));
      const started = Date.now();
      const executable = await installPinned(env, new AbortController().signal, () => undefined, digests);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(execFileSync(executable, { encoding: 'utf8' }).trim()).toBe('1.3.1');
      expect(existsSync(`${entry}.lock`)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports a failed download as AGENT_DESKTOP_INSTALL_FAILED', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const env = { HOME: '/nonexistent', USERPROFILE: '/nonexistent', XDG_CACHE_HOME: '/nonexistent/cache', LOCALAPPDATA: '/nonexistent/local' };
    await expect(installPinned(env, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'AGENT_DESKTOP_INSTALL_FAILED' });
  });
});
