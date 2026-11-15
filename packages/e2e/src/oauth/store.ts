/**
 * Credentials between runs: one JSON file keyed by provider id, mode 0600.
 * Writes hold an advisory lock and replace the file atomically, so two runs
 * writing at once neither tear the file nor lose each other's entries. A
 * refresh holds a lock for its login from its read to its write, so worker
 * processes send a rotating refresh token once between them.
 * `E2E_OAUTH_CREDENTIALS` holding the same JSON stands in for the file on a
 * machine the user cannot sign in on; that store refuses to write.
 */

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { OAuthError } from './errors.ts';
import type { CredentialStore, OAuthCredentials } from './types.ts';

export const CREDENTIALS_ENV = 'E2E_OAUTH_CREDENTIALS';

type CredentialsFile = Record<string, OAuthCredentials>;

/** `$XDG_CONFIG_HOME/e2e/oauth.json`, or `~/.config/e2e/oauth.json`. */
export function defaultCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env['XDG_CONFIG_HOME'];
  const base = configHome !== undefined && configHome !== '' ? configHome : path.join(homedir(), '.config');
  return path.join(base, 'e2e', 'oauth.json');
}

/** The store the model constructors and the CLI use: the environment variable when set, else the file. */
export function defaultCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  const fromEnv = env[CREDENTIALS_ENV];
  return fromEnv !== undefined && fromEnv !== '' ? new EnvCredentialStore(fromEnv) : new FileCredentialStore(defaultCredentialsPath(env));
}

const LOCK_RETRY_MS = 25;
/** How long a lock may go untouched before waiters take it over, whoever it names. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
/** A token request has no deadline of its own, so a waiter gives up on its own. */
const REFRESH_LOCK_WAIT_MS = 30_000;

export class FileCredentialStore implements CredentialStore {
  readonly path: string;

  constructor(file: string = defaultCredentialsPath()) {
    this.path = file;
  }

  async get(providerId: string): Promise<OAuthCredentials | undefined> {
    return this.read()[providerId];
  }

  async set(providerId: string, credentials: OAuthCredentials): Promise<void> {
    await this.update((all) => ({ ...all, [providerId]: credentials }));
  }

  async remove(providerId: string): Promise<void> {
    await this.update((all) => {
      const { [providerId]: _removed, ...rest } = all;
      return rest;
    });
  }

  async list(): Promise<string[]> {
    return Object.keys(this.read());
  }

  async exclusive<T>(providerId: string, refresh: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.${providerId}.refresh.lock`;
    const release = await this.lock(lockPath, REFRESH_LOCK_WAIT_MS, () => {
      const message = `another worker is still refreshing the ${providerId} login after ${REFRESH_LOCK_WAIT_MS / 1000} s`;
      return new OAuthError('TIMEOUT', `${message}; run again once it finishes`);
    });
    try {
      return await refresh();
    } finally {
      release();
    }
  }

  private read(): CredentialsFile {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw cause;
    }
    return parseCredentials(text, this.path);
  }

  /** Read-modify-write under the lock, then an atomic replace. */
  private async update(change: (all: CredentialsFile) => CredentialsFile): Promise<void> {
    const dir = path.dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Creation modes only apply to new paths; a directory or file that already existed keeps what it had unless told otherwise.
    chmodSync(dir, 0o700);
    const lockPath = `${this.path}.lock`;
    const release = await this.lock(lockPath, LOCK_WAIT_MS, () => {
      return new Error(`${lockPath} is held by another process; remove it if that process is gone`);
    });
    try {
      const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(change(this.read()), null, 2)}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      try {
        renameSync(temp, this.path);
      } catch (cause) {
        rmSync(temp, { force: true });
        throw cause;
      }
    } finally {
      release();
    }
  }

  /**
   * An advisory lock file created exclusively. It names its holder
   * (`lockToken`), and the holder touches it while it holds it, so waiters take
   * it over at once when the holder has exited and otherwise only once it has
   * gone untouched for the stale bound. The holder touches and releases only
   * its own lock.
   */
  private async lock(lockPath: string, waitMs: number, busy: () => Error): Promise<() => void> {
    const token = lockToken();
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (claim(lockPath, token)) {
        const heartbeat = setInterval(() => {
          if (readLock(lockPath) === token) touch(lockPath);
        }, LOCK_STALE_MS / 4);
        heartbeat.unref();
        return () => {
          clearInterval(heartbeat);
          if (readLock(lockPath) === token) rmSync(lockPath, { force: true });
        };
      }
      if (Date.now() > deadline) throw busy();
      if (abandoned(lockPath) && breakAbandoned(lockPath)) continue;
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

/** Creates `lockPath` holding `token`, false when it exists; a lock whose write failed is removed. */
function claim(lockPath: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw cause;
  }
  try {
    writeSync(fd, token);
  } catch (cause) {
    rmSync(lockPath, { force: true });
    throw cause;
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * This host and, where the system has them, its pid namespace, since a
 * sandbox on the same host sees none of the pids outside it.
 */
function holderHost(): string {
  try {
    return `${hostname()}/${readlinkSync('/proc/self/ns/pid')}`;
  } catch {
    return hostname();
  }
}

/** This process on this host, and a random part no other holder shares. */
function lockToken(): string {
  return `${holderHost()} ${process.pid} ${randomUUID()}`;
}

function touch(lockPath: string): void {
  const now = new Date();
  try {
    utimesSync(lockPath, now, now);
  } catch {
    // Released meanwhile.
  }
}

function readLock(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * True when the lock's holder on this host and pid namespace has exited, or
 * the lock has gone untouched for the stale bound. The bound covers what the
 * pid cannot tell: a lock from another host, sandbox, or older e2e, a pid
 * another program now has, and a holder suspended that long, which then
 * loses its lock.
 */
function abandoned(lockPath: string): boolean {
  const text = readLock(lockPath);
  if (text === undefined) return false;
  const [host, pid] = text.split(' ');
  if (host === holderHost() && pid !== undefined && /^\d+$/.test(pid) && !running(Number(pid))) return true;
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** True while `pid` exists, whoever owns it. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists but belongs to another user.
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes an abandoned lock, false when another waiter is removing it.
 * Waiters take turns through a second lock file and check the holder again
 * while they hold it, so a lock created after the first check is never
 * removed. A waiter that exits inside its turn, which lasts microseconds,
 * leaves that file for the next waiter to take over; two waiters doing so at
 * the same moment can still both remove.
 */
function breakAbandoned(lockPath: string): boolean {
  const breaker = `${lockPath}.break`;
  if (!claim(breaker, lockToken())) {
    if (abandoned(breaker)) rmSync(breaker, { force: true });
    return false;
  }
  try {
    if (abandoned(lockPath)) rmSync(lockPath, { force: true });
    return true;
  } finally {
    rmSync(breaker, { force: true });
  }
}

/** Credentials from the environment variable: readable everywhere, changed nowhere. */
export class EnvCredentialStore implements CredentialStore {
  private readonly entries: CredentialsFile;
  constructor(json: string, source: string = CREDENTIALS_ENV) {
    this.entries = parseCredentials(json, source);
  }
  async get(providerId: string): Promise<OAuthCredentials | undefined> {
    return this.entries[providerId];
  }
  assertWritable(): never {
    throw new OAuthError('MISCONFIGURED', `${CREDENTIALS_ENV} is set, so logins come from the environment and cannot be changed here; unset it to sign in on this machine`);
  }
  async set(): Promise<void> {
    this.assertWritable();
  }
  async remove(): Promise<void> {
    return this.set();
  }
  async list(): Promise<string[]> {
    return Object.keys(this.entries);
  }
  /** Each process holds its own copy of the variable, so there is nothing to share a refresh with. */
  async exclusive<T>(_providerId: string, refresh: () => Promise<T>): Promise<T> {
    return refresh();
  }
}

/** The file's entries; one damaged entry is dropped rather than taking every login down with it. */
function parseCredentials(text: string, source: string): CredentialsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${source} is not valid JSON`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} must hold an object keyed by provider id`);
  }
  const out: CredentialsFile = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isCredentials(value)) out[id] = value;
  }
  return out;
}

function isCredentials(value: unknown): value is OAuthCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['access'] === 'string' && typeof record['refresh'] === 'string' && typeof record['expires'] === 'number';
}
