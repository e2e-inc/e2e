import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIALS_ENV, EnvCredentialStore, FileCredentialStore, defaultCredentialStore, defaultCredentialsPath } from '../../../src/oauth/store.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, statSync: vi.fn(fs.statSync), writeFileSync: vi.fn(fs.writeFileSync), rmSync: vi.fn(fs.rmSync), linkSync: vi.fn(fs.linkSync) };
});
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const realStatSync = realFs.statSync;

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-oauth-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'oauth.json');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const creds = { access: 'a', refresh: 'r', expires: 123, accountId: 'acct' };
/** What a lock held by `pid` on this host holds. */
const heldBy = (pid: number) => `${hostname()} ${pid} other`;
/** The pid of a process that has exited. */
const exitedPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('FileCredentialStore', () => {
  it('creates the file with owner-only permissions and round-trips entries', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    expect(await store.get('spacexai')).toBeUndefined();
    await store.set('spacexai', creds);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(await store.get('spacexai')).toEqual(creds);
    expect(await store.list()).toEqual(['spacexai']);
    await store.remove('spacexai');
    expect(await store.list()).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('{}\n');
    expect(() => statSync(`${file}.lock`)).toThrow();
  });

  it('keeps other providers when one is written, even from concurrent writers', async () => {
    const file = tempFile();
    const a = new FileCredentialStore(file);
    const b = new FileCredentialStore(file);
    await Promise.all([a.set('a', creds), b.set('b', { ...creds, access: 'b' }), a.set('c', { ...creds, access: 'c' })]);
    expect((await a.list()).toSorted()).toEqual(['a', 'b', 'c']);
    expect((await b.get('b'))?.access).toBe('b');
  });

  it('defers a writer while another process holds the lock', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    writeFileSync(`${file}.lock`, '');
    let settled = false;
    const pending = store.set('y', creds).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    rmSync(`${file}.lock`, { force: true });
    await pending;
    expect((await store.list()).toSorted()).toEqual(['x', 'y']);
  });

  it('tightens the permissions of a directory and file that already existed', async () => {
    const file = tempFile();
    const { mkdirSync, chmodSync } = await import('node:fs');
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    writeFileSync(file, '{}', { mode: 0o644 });
    chmodSync(file, 0o644);
    await new FileCredentialStore(file).set('x', creds);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('takes over a stale lock left by a dead process', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    writeFileSync(`${file}.lock`, '');
    const old = Date.now() / 1000 - 60;
    utimesSync(`${file}.lock`, old, old);
    await store.set('y', creds);
    expect((await store.list()).toSorted()).toEqual(['x', 'y']);
  });

  it('never takes over a lock another process created after the check', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    const lock = `${file}.x.refresh.lock`;
    writeFileSync(lock, '');
    const old = Date.now() / 1000 - 60;
    utimesSync(lock, old, old);
    // Between this process's stale check and its takeover, another process takes the stale lock over and holds a fresh one.
    vi.mocked(statSync).mockImplementationOnce(((target: string) => {
      const stats = realStatSync(target);
      rmSync(lock);
      writeFileSync(lock, heldBy(process.pid));
      return stats;
    }) as typeof statSync);
    let entered = false;
    const pending = store.exclusive('x', async () => {
      entered = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(entered).toBe(false);
    rmSync(lock);
    await pending;
    expect(entered).toBe(true);
  });

  it('releases the refresh lock when the refresh throws', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    await expect(store.exclusive('x', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(existsSync(`${file}.x.refresh.lock`)).toBe(false);
    expect(await store.exclusive('x', async () => 'next')).toBe('next');
  });

  it('waits for a live holder however old its lock is', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    const lock = `${file}.x.refresh.lock`;
    // A holder suspended past the stale bound, or a laptop asleep mid-refresh, still holds the lock.
    writeFileSync(lock, heldBy(process.pid));
    const old = Date.now() / 1000 - 60;
    utimesSync(lock, old, old);
    let entered = false;
    const pending = store.exclusive('x', async () => {
      entered = true;
    });
    await sleep(150);
    expect(entered).toBe(false);
    rmSync(lock);
    await pending;
    expect(entered).toBe(true);
  });

  it('takes over at once a lock whose holder exited', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    writeFileSync(`${file}.x.refresh.lock`, heldBy(exitedPid()));
    const started = Date.now();
    expect(await store.exclusive('x', async () => 'entered')).toBe('entered');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(existsSync(`${file}.x.refresh.lock`)).toBe(false);
  });

  it('gives up on time while another waiter holds the takeover turn', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    writeFileSync(`${file}.lock`, heldBy(exitedPid()));
    const old = Date.now() / 1000 - 60;
    utimesSync(`${file}.lock`, old, old);
    writeFileSync(`${file}.lock.break`, heldBy(process.pid));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const pending = expect(store.set('y', creds)).rejects.toThrow(`${file}.lock is held by another process`);
      await vi.advanceTimersByTimeAsync(6_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no lock behind when writing its holder fails', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    vi.mocked(writeFileSync).mockImplementationOnce(((target: string, data: string) => {
      realFs.writeFileSync(target, data.slice(0, 10));
      throw Object.assign(new Error('file too large'), { code: 'EFBIG' });
    }) as typeof writeFileSync);
    await expect(store.exclusive('x', async () => 'entered')).rejects.toThrow('file too large');
    expect(readdirSync(path.dirname(file)).filter((name) => name.includes('.lock'))).toEqual([]);
    expect(await store.exclusive('x', async () => 'entered')).toBe('entered');
  });

  it('gives up on time while the locks of exiting holders keep replacing each other', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    const lock = `${file}.lock`;
    const exited = heldBy(exitedPid());
    writeFileSync(lock, exited);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // Each takeover is followed by another holder taking the lock and exiting, a second later.
    let takeovers = 0;
    vi.mocked(rmSync).mockImplementation(((target: string, options?: object) => {
      realFs.rmSync(target, options);
      if (target === lock && takeovers++ < 20) {
        realFs.writeFileSync(lock, exited);
        vi.setSystemTime(Date.now() + 1_000);
      }
    }) as typeof rmSync);
    try {
      await expect(store.set('y', creds)).rejects.toThrow(`${lock} is held by another process`);
      expect(takeovers).toBeLessThan(10);
    } finally {
      vi.mocked(rmSync).mockImplementation(realFs.rmSync);
      vi.useRealTimers();
    }
  });

  it('creates the lock directly on a file system without hard links', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    vi.mocked(linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });
    expect(await store.exclusive('x', async () => readFileSync(`${file}.x.refresh.lock`, 'utf8'))).toMatch(new RegExp(`^${hostname()} ${process.pid} `));
    expect(readdirSync(path.dirname(file)).filter((name) => name.includes('.lock'))).toEqual([]);
  });

  it('refreshes different providers at once', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('a', creds);
    let finishA = () => {};
    const a = store.exclusive('a', () => new Promise<void>((resolve) => (finishA = resolve)));
    expect(await store.exclusive('b', async () => 'b')).toBe('b');
    finishA();
    await a;
  });

  it('drops a damaged entry instead of losing every login', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    writeFileSync(file, JSON.stringify({ x: creds, broken: { access: 1 }, nan: { access: 'a', refresh: 'r', expires: null } }));
    expect(await store.list()).toEqual(['x']);
    expect(await store.get('broken')).toBeUndefined();
  });

  it('defaults to the XDG config directory', () => {
    expect(defaultCredentialsPath({ XDG_CONFIG_HOME: '/tmp/xdg' })).toBe('/tmp/xdg/e2e/oauth.json');
    expect(defaultCredentialsPath({})).toMatch(/\.config\/e2e\/oauth\.json$/);
  });
});

describe('EnvCredentialStore', () => {
  it('is chosen when the variable is set, reads it, and refuses to change it', async () => {
    const store = defaultCredentialStore({ [CREDENTIALS_ENV]: JSON.stringify({ 'github-copilot': creds }) });
    expect(store).toBeInstanceOf(EnvCredentialStore);
    expect(await store.get('github-copilot')).toEqual(creds);
    expect(await store.list()).toEqual(['github-copilot']);
    await expect(store.set('spacexai', creds)).rejects.toMatchObject({ code: 'MISCONFIGURED', message: expect.stringContaining(CREDENTIALS_ENV) });
    await expect(store.remove('github-copilot')).rejects.toMatchObject({ code: 'MISCONFIGURED' });
    expect(defaultCredentialStore({ [CREDENTIALS_ENV]: '' })).toBeInstanceOf(FileCredentialStore);
  });

  it('rejects malformed JSON naming the variable', () => {
    expect(() => new EnvCredentialStore('nope')).toThrow(new RegExp(`${CREDENTIALS_ENV} is not valid JSON`));
  });
});
