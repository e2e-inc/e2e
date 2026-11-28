/** An Android emulator's snapshot: the app's data directory, and its keys in the Keystore database when the emulator gives root. */

import path from 'node:path';
import { z } from 'zod';
import { invalidState, unsupported } from '../support.ts';
import { failure, packFiles, run, STAGING, unpackFiles, unreadableFiles, type PlatformState, type RunOptions, type StateTarget } from './host.ts';
import { insertRow, Rows, SecureStore, type Row, type Schema } from './rows.ts';

const KEYSTORE_DATABASE = '/data/misc/keystore/persistent.sqlite';
/** A key entry, its blobs and their metadata, and the tables that hang off the entry by `keyentryid`. */
const Keystore = z.object({ keyentry: Rows, blobentry: Rows, blobmetadata: Rows, keyparameter: Rows, keymetadata: Rows });
type Keystore = z.infer<typeof Keystore>;
const KEYSTORE_TABLES = ['keyentry', 'blobentry', 'blobmetadata', 'keyparameter', 'keymetadata'] as const;
const NO_KEYS: Keystore = { keyentry: [], blobentry: [], blobmetadata: [], keyparameter: [], keymetadata: [] };

const AndroidState = z.object({
  platform: z.literal('android'),
  app: z.string(),
  /** The data directory: a gzipped tar, base64. */
  files: z.string(),
  /** Absent when the emulator gave no root: the files of a debuggable build, read as the app itself. */
  keystore: Keystore.optional(),
});
type AndroidState = z.infer<typeof AndroidState>;

interface Owner {
  readonly uid: string;
  readonly label: string;
}

/** Kept in place and emptied: their group is the app's cache gid, which a restore as root would lose. */
const CACHES = ['cache', 'code_cache'];
const ROOT = ['su', '0'];

function adbPath(): string {
  const sdk = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
  return sdk === undefined || sdk === '' ? 'adb' : path.join(sdk, 'platform-tools', 'adb');
}

/** The app on one emulator, reached as root, or as the app itself when root is refused and the build is debuggable. */
class Emulator {
  private constructor(
    private readonly target: StateTarget,
    private readonly signal: AbortSignal,
    readonly root: boolean,
  ) {}

  static async open(target: StateTarget, signal: AbortSignal): Promise<Emulator> {
    const adb = (prefix: readonly string[]) => run('checking device access', adbPath(), ['-s', target.deviceId, 'shell', '-T', ...prefix, 'id', '-u'], { signal, allowFailure: true });
    if ((await adb(ROOT)).toString('utf8').trim() === '0') return new Emulator(target, signal, true);
    if (/^\d+$/.test((await adb(['run-as', target.app])).toString('utf8').trim())) return new Emulator(target, signal, false);
    throw unsupported(
      `a session can be saved on an Android emulator with root access (any image without Google Play), or for a debuggable build; ${target.deviceId} gives neither for ${target.app}`,
    );
  }

  /**
   * Runs a command on the device. `shell`, never `exec-out` or `exec-in`: those
   * drop the command's exit code, so a failed read would pass for a short one.
   * `-T` keeps adb from allocating a terminal, so bytes pass both ways unchanged.
   */
  private shell(step: string, command: readonly string[], stdin?: RunOptions['stdin']): Promise<Buffer> {
    return run(step, adbPath(), ['-s', this.target.deviceId, 'shell', '-T', ...command], { signal: this.signal, ...(stdin === undefined ? {} : { stdin }) });
  }

  private get dataAccess(): readonly string[] {
    return this.root ? ROOT : ['run-as', this.target.app];
  }

  private get dataDir(): string {
    return `/data/data/${this.target.app}`;
  }

  async stop(): Promise<void> {
    await this.shell('stopping the app', ['am', 'force-stop', this.target.app]);
  }

  readFiles(): Promise<Buffer> {
    const excludes = [...CACHES, STAGING].flatMap((entry) => ['--exclude', `./${entry}`]);
    return this.shell('reading the app data', [...this.dataAccess, 'tar', '-cf', '-', '-C', this.dataDir, ...excludes, '.']);
  }

  /** The uid the device installed the app under and the SELinux label of its data directory: both differ from one device to the next. */
  async owner(): Promise<Owner> {
    const listed = (await this.shell('reading the app id', ['cmd', 'package', 'list', 'packages', '-U', this.target.app])).toString('utf8');
    const uid = listed.split('\n').find((line) => line.startsWith(`package:${this.target.app} `))?.match(/uid:(\d+)/)?.[1];
    if (uid === undefined) throw failure(`reading the app id: ${this.target.app} is not installed on ${this.target.deviceId}`);
    const label = (await this.shell('reading the app data', [...ROOT, 'stat', '-c', '%C', this.dataDir])).toString('utf8').trim();
    if (!/^[A-Za-z0-9_:,.]+$/.test(label)) throw failure(`reading the app data: ${this.target.app} has no data directory on ${this.target.deviceId}`);
    return { uid, label };
  }

  /**
   * Puts the archive in place of the app's files. It unpacks beside them, so
   * they go only once their replacement is whole and, extracted as root, is
   * the app's: `owner` is absent when the app itself does the unpacking.
   * Never `pm clear`: it deletes the app's Keystore keys along with its files.
   */
  async replaceFiles(archive: Buffer, owner: Owner | undefined): Promise<void> {
    const script = (step: string, ...lines: string[]) => this.shell(step, [...this.dataAccess, 'sh'], ['set -e', `cd ${this.dataDir}`, ...lines, ''].join('\n'));
    await script('writing the app data', `rm -rf ${STAGING}`, `mkdir ${STAGING}`);
    await this.shell('writing the app data', [...this.dataAccess, 'tar', '-xf', '-', '-C', `${this.dataDir}/${STAGING}`], archive);
    // A hard link joins a file outside the app's data to the tree handed to the app below; a device node or a pipe is not data.
    const strays = await script('checking the app data', `find ${STAGING} '(' ! -type d -links +1 ')' -o -type b -o -type c -o -type p | head -n 1`);
    if (strays.length > 0) {
      await script('checking the app data', `rm -rf ${STAGING}`);
      throw unreadableFiles();
    }
    await script(
      'writing the app data',
      // `-h`: a symlink in the archive is handed over itself, never what it points at.
      ...(owner === undefined ? [] : [`chown -hR ${owner.uid}:${owner.uid} ${STAGING}`, `chcon -hR ${owner.label} ${STAGING}`]),
      `find . -mindepth 1 -maxdepth 1 ${[...CACHES, STAGING].map((entry) => `! -name ${entry}`).join(' ')} -exec rm -rf {} +`,
      `for cache in ${CACHES.join(' ')}; do if [ -d "$cache" ]; then find "$cache" -mindepth 1 -delete; fi; done`,
      // A loop and not `find -exec mv`, whose failures find keeps to itself.
      `for entry in ${STAGING}/* ${STAGING}/.[!.]* ${STAGING}/..?*; do`,
      `  case "\${entry##*/}" in ${CACHES.join('|')}) continue ;; esac`,
      '  if [ -e "$entry" ] || [ -L "$entry" ]; then mv "$entry" .; fi',
      'done',
      `rm -rf ${STAGING}`,
    );
  }

  /** The emulator's Keystore database, through its own sqlite3 as root. */
  get keystore(): SecureStore {
    return new SecureStore('keystore', (step, sql) => this.shell(step, [...ROOT, 'sqlite3', '-safe', '-bail', KEYSTORE_DATABASE], `.timeout 5000\n${sql}`));
  }
}

/** The app's own keys: `domain` 0 is an app's namespace, which is its uid. */
const ownedBy = (uid: string) => `domain = 0 and namespace = ${uid}`;

async function capture(target: StateTarget, signal: AbortSignal): Promise<AndroidState> {
  const emulator = await Emulator.open(target, signal);
  await emulator.stop();
  const files = await packFiles(await emulator.readFiles());
  if (!emulator.root) return { platform: 'android', app: target.app, files };

  const { uid } = await emulator.owner();
  const { keystore } = emulator;
  const entries = `(select id from keyentry where ${ownedBy(uid)})`;
  const [keyentry, blobentry, blobmetadata, keyparameter, keymetadata] = await Promise.all([
    keystore.rows('keyentry', ownedBy(uid)),
    keystore.rows('blobentry', `keyentryid in ${entries}`),
    keystore.rows('blobmetadata', `blobentryid in (select id from blobentry where keyentryid in ${entries})`),
    keystore.rows('keyparameter', `keyentryid in ${entries}`),
    keystore.rows('keymetadata', `keyentryid in ${entries}`),
  ]);
  return { platform: 'android', app: target.app, files, keystore: { keyentry, blobentry, blobmetadata, keyparameter, keymetadata } };
}

async function restore(target: StateTarget, data: unknown, signal: AbortSignal): Promise<void> {
  const saved = AndroidState.safeParse(data);
  if (!saved.success) throw invalidState('the saved session is not an Android app state');
  const archive = await unpackFiles(saved.data.files);
  const emulator = await Emulator.open(target, signal);
  if (saved.data.keystore !== undefined && !emulator.root) {
    throw unsupported(`the saved session carries Keystore keys, which need root access to restore, and ${target.deviceId} gives none`);
  }
  if (!emulator.root) {
    await emulator.stop();
    await emulator.replaceFiles(archive, undefined);
    return;
  }
  const owner = await emulator.owner();
  const { keystore } = emulator;
  // Planned before the app is stopped: a snapshot this emulator's Keystore cannot take is refused with the app untouched.
  // A snapshot without keys still replaces the app's state, so the keys of whoever was signed in go.
  const keys = replaceKeys(saved.data.keystore ?? NO_KEYS, owner.uid, await keystore.schema(KEYSTORE_TABLES));
  await emulator.stop();
  await emulator.replaceFiles(archive, owner);
  await keystore.write(keys);
}

/**
 * The statements that put `saved` in place of the keys `uid` owns. Every saved
 * row lands under that uid or hangs off a saved key, so a snapshot reaches no
 * other app's keys. An id another app's key already holds fails the write:
 * ids are unique across the store, and random.
 */
export function replaceKeys(saved: Keystore, uid: string, schema: Schema): string[] {
  const insert = (table: keyof Keystore, row: Row, overrides?: Row) => insertRow(table, row, schema, overrides);
  const ids = new Set(saved.keyentry.map((row) => row['id']));
  const blobs = new Set(saved.blobentry.map((row) => row['id']));
  const strays = [...saved.blobentry, ...saved.keyparameter, ...saved.keymetadata].some((row) => !ids.has(row['keyentryid']));
  if (strays || ids.has(undefined) || blobs.has(undefined) || saved.blobmetadata.some((row) => !blobs.has(row['blobentryid']))) {
    throw invalidState('the saved session holds Keystore rows that belong to no key in it');
  }
  const entries = `(select id from keyentry where ${ownedBy(uid)})`;
  return [
    `delete from blobmetadata where blobentryid in (select id from blobentry where keyentryid in ${entries});`,
    `delete from blobentry where keyentryid in ${entries};`,
    `delete from keyparameter where keyentryid in ${entries};`,
    `delete from keymetadata where keyentryid in ${entries};`,
    `delete from grant where keyentryid in ${entries};`,
    `delete from keyentry where ${ownedBy(uid)};`,
    // An app's key lives in domain 0 under its uid, which differs from one device to the next.
    ...saved.keyentry.map((row) => insert('keyentry', row, { domain: '0', namespace: uid })),
    // A blob's id is the device's to assign, the highest so far; its metadata follows it to the new one.
    ...saved.blobentry.flatMap(({ id, ...blob }) => [
      insert('blobentry', blob),
      ...saved.blobmetadata
        .filter((row) => row['blobentryid'] === id)
        .map(({ id: _id, ...metadata }) => insert('blobmetadata', metadata, { blobentryid: '(select max(id) from blobentry)' })),
    ]),
    ...saved.keyparameter.map((row) => insert('keyparameter', row)),
    ...saved.keymetadata.map((row) => insert('keymetadata', row)),
  ];
}

export const android: PlatformState = { capture, restore };
