import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIALS_ENV, EnvCredentialStore, FileCredentialStore, defaultCredentialStore, defaultCredentialsPath } from '../../../src/oauth/store.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, statSync: vi.fn(fs.statSync), writeSync: vi.fn(fs.writeSync), rmSync: vi.fn(fs.rmSync), utimesSync: vi.fn(fs.utimesSync) };
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
  for (const mocked of [statSync, writeSync, rmSync, utimesSync]) vi.mocked(mocked).mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const creds = { access: 'a', refresh: 'r', expires: 123, accountId: 'acct' };
/** This host and pid namespace, as a lock names them. */
const host = existsSync('/proc/self/ns/pid') ? `${hostname()}/${readlinkSync('/proc/self/ns/pid')}` : hostname();
/** What a lock held by `pid` on this host holds. */
const heldBy = (pid: number) => `${host} ${pid} other`;
/** The pid of a process that has exited. */
const exitedPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Sets the file's times `seconds` from now. */
const age = (file: string, seconds: number) => utimesSync(file, Date.now() / 1000 + seconds, Date.now() / 1000 + seconds);
/** Whether `exclusive` on `providerId` enters within 150 ms; the attempt is left to finish once the lock is removed. */
async function entersAtOnce(store: FileCredentialStore, providerId: string): Promise<{ entered: boolean; pending: Promise<unknown> }> {
  const state = { entered: false };
  const pending = store.exclusive(providerId, async () => {
    state.entered = true;
  });
  await sleep(150);
  return { entered: state.entered, pending };
}

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

  it.each([
    ['this process', () => heldBy(process.pid)],
    // Run as root, pid 1 can be signalled, so this checks a running process instead.
    ['a process of another user', () => heldBy(1)],
    ['another host', () => `elsewhere.example ${exitedPid()} other`],
    ['another pid namespace on this host', () => `${hostname()}/pid:[1] ${exitedPid()} other`],
    ['no pid', () => `${host} unknown other`],
  ])('waits for a fresh lock held by %s', async (_holder, content) => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    const lock = `${file}.x.refresh.lock`;
    writeFileSync(lock, content());
    const { entered, pending } = await entersAtOnce(store, 'x');
    expect(entered).toBe(false);
    rmSync(lock);
    await pending;
  });

  it('takes over a lock its holder stopped touching, even when the pid runs', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    // A pid that now belongs to another program, or a holder suspended past the stale bound.
    writeFileSync(`${file}.x.refresh.lock`, heldBy(process.pid));
    age(`${file}.x.refresh.lock`, -60);
    const { entered, pending } = await entersAtOnce(store, 'x');
    expect(entered).toBe(true);
    await pending;
  });

  it('keeps a held lock fresh, so waiters never take it as untouched', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    const lock = `${file}.x.refresh.lock`;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await store.exclusive('x', async () => {
        age(lock, -60);
        // A holder touches its lock several times within the stale bound.
        vi.advanceTimersByTime(3_000);
        expect(statSync(lock).mtimeMs).toBeGreaterThan(Date.now() - 5_000);
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps its heartbeat going when the lock vanishes between the check and the touch', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await store.exclusive('x', async () => {
        vi.mocked(utimesSync).mockImplementationOnce(() => {
          throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
        });
        expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never removes or touches a lock it no longer holds', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    const lock = `${file}.x.refresh.lock`;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await store.exclusive('x', async () => {
        // A waiter took the lock over and holds it now.
        writeFileSync(lock, heldBy(process.pid));
        age(lock, -60);
        vi.advanceTimersByTime(10_000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(readFileSync(lock, 'utf8')).toBe(heldBy(process.pid));
    expect(statSync(lock).mtimeMs).toBeLessThan(Date.now() - 30_000);
  });

  it('leaves the lock of another attempt in this process that took over', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    const lock = `${file}.x.refresh.lock`;
    let second: Promise<unknown> = Promise.resolve();
    let finishSecond = () => {};
    await store.exclusive('x', async () => {
      // Untouched past the stale bound, so a second attempt from this process takes it over.
      age(lock, -60);
      let entered = () => {};
      const inside = new Promise<void>((resolve) => (entered = resolve));
      second = store.exclusive('x', () => {
        entered();
        return new Promise<void>((resolve) => (finishSecond = resolve));
      });
      await inside;
    });
    expect(existsSync(lock)).toBe(true);
    finishSecond();
    await second;
    expect(existsSync(lock)).toBe(false);
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

  it('lets one process at a time through an orphaned lock', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('test', creds);
    // An empty lock gone untouched past the stale bound, as a crashed older e2e leaves it.
    writeFileSync(`${file}.test.refresh.lock`, '');
    age(`${file}.test.refresh.lock`, -60);
    const log = path.join(path.dirname(file), 'log');
    writeFileSync(log, '');
    const worker = [
      '--import',
      new URL('../../../src/config/register.ts', import.meta.url).href,
      fileURLToPath(new URL('./helpers/exclusive-worker.ts', import.meta.url)),
    ];
    // One start time, after every process has booted, so they all find the orphaned lock at once.
    const startAt = String(Date.now() + 2_000);
    const run = () => promisify(execFile)(process.execPath, [...worker, file, log, startAt]);
    await Promise.all(Array.from({ length: 8 }, run));
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(16);
    for (let i = 0; i < lines.length; i += 2) expect([lines[i]?.[0], lines[i + 1]]).toEqual(['+', `-${lines[i]?.slice(1)}`]);
  }, 20_000);

  it('takes over the turn of a waiter that exited during it', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    writeFileSync(`${file}.x.refresh.lock`, heldBy(exitedPid()));
    writeFileSync(`${file}.x.refresh.lock.break`, heldBy(exitedPid()));
    const { entered, pending } = await entersAtOnce(store, 'x');
    expect(entered).toBe(true);
    await pending;
    expect(readdirSync(path.dirname(file)).filter((name) => name.includes('.lock'))).toEqual([]);
  });

  it('gives up with TIMEOUT after 30 s of another worker refreshing', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    const lock = `${file}.x.refresh.lock`;
    writeFileSync(lock, heldBy(process.pid));
    // Touched in the future, so the lock stays fresh however far the fake clock moves.
    age(lock, 3_600);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let settled = false;
      const pending = store.exclusive('x', async () => {}).finally(() => {
        settled = true;
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'TIMEOUT',
        message: expect.stringContaining('still refreshing the x login after 30 s'),
      });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
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
    vi.mocked(writeSync).mockImplementationOnce(((fd: number, data: string) => {
      realFs.writeSync(fd, data.slice(0, 10));
      throw Object.assign(new Error('file too large'), { code: 'EFBIG' });
    }) as unknown as typeof writeSync);
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
      vi.useRealTimers();
    }
  });

  it('fails at once when the lock cannot be created', async () => {
    const store = new FileCredentialStore(path.join(path.dirname(tempFile()), 'missing', 'oauth.json'));
    const started = Date.now();
    await expect(store.exclusive('x', async () => 'entered')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(Date.now() - started).toBeLessThan(1_000);
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
