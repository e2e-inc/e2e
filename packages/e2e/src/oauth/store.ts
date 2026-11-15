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
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
/** Longer than the stale bound, so a waiter outlasts a refresh lock its dead holder left. */
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
    const lock = await this.lock(`${this.path}.${providerId}.refresh.lock`, REFRESH_LOCK_WAIT_MS, () => {
      // The holder may be alive: a token request has no deadline of its own.
      return new OAuthError('TIMEOUT', `another worker is still refreshing the ${providerId} login after ${REFRESH_LOCK_WAIT_MS / 1000} s; run again once it finishes`);
    });
    // A slow token request must not look like a dead process's lock to the waiters.
    const heartbeat = setInterval(() => lock.touch(), LOCK_STALE_MS / 4);
    heartbeat.unref();
    try {
      return await refresh();
    } finally {
      clearInterval(heartbeat);
      lock.release();
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
    const lock = await this.lock(lockPath, LOCK_WAIT_MS, (cause) => new Error(`${lockPath} is held by another process; remove it if that process is gone`, { cause }));
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
      lock.release();
    }
  }

  /**
   * An advisory lock file created exclusively, holding a token only this
   * holder knows, so it releases and touches its own lock and never one a
   * waiter took over. A lock older than the stale bound was left by a dead
   * process and is taken over (`breakStale`).
   */
  private async lock(lockPath: string, waitMs: number, busy: (cause: unknown) => Error): Promise<HeldLock> {
    const token = `${process.pid}.${randomUUID()}`;
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 });
        return heldLock(lockPath, token);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        if (isStale(lockPath)) {
          if (breakStale(lockPath)) continue;
        } else if (Date.now() > deadline) {
          throw busy(cause);
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
  }
}

interface HeldLock {
  release(): void;
  /** Marks the lock as alive, so waiters do not take it for a dead process's. */
  touch(): void;
}

function heldLock(lockPath: string, token: string): HeldLock {
  const owned = () => {
    try {
      return readFileSync(lockPath, 'utf8') === token;
    } catch {
      return false;
    }
  };
  return {
    release: () => {
      if (owned()) rmSync(lockPath, { force: true });
    },
    touch: () => {
      if (!owned()) return;
      const now = new Date();
      try {
        utimesSync(lockPath, now, now);
      } catch {
        // Released meanwhile; the next refresh takes a fresh lock.
      }
    },
  };
}

/**
 * Removes a stale lock, false when another waiter is removing it. Waiters
 * take turns through a second lock file and check the age again while they
 * hold it, so a lock a live process created after the first check is never
 * removed. That file is held for microseconds, so one older than the stale
 * bound was left by a waiter that died in between.
 */
function breakStale(lockPath: string): boolean {
  const breaker = `${lockPath}.break`;
  try {
    writeFileSync(breaker, '', { flag: 'wx', mode: 0o600 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    if (isStale(breaker)) rmSync(breaker, { force: true });
    return false;
  }
  try {
    if (isStale(lockPath)) rmSync(lockPath, { force: true });
    return true;
  } finally {
    rmSync(breaker, { force: true });
  }
}

/** True when the file was last touched longer ago than the stale bound; a missing file is not stale. */
function isStale(file: string): boolean {
  try {
    return Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
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
