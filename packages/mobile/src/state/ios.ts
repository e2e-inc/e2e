/** An iOS simulator's snapshot: the app's data container, and its items in the simulator's keychain database. */

import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { invalidState, unsupported } from '../support.ts';
import { failure, packFiles, run, STAGING, unpackFiles, unreadableFiles, type PlatformState, type RunOptions, type StateTarget } from './host.ts';
import { insertRow, Rows, SecureStore, type Row } from './rows.ts';

/** The keychain's item tables, one per item class. */
const ITEM_TABLES = ['genp', 'inet', 'cert', 'keys'] as const;
/**
 * The keys a simulator's keychain encrypts item attributes with, one row per
 * protection class, generated per simulator. An item row reads only beside
 * the keys it was written under, so a snapshot carries them.
 */
const KEYS_TABLE = 'metadatakeys';

const IosState = z.object({
  platform: z.literal('ios'),
  app: z.string(),
  /** The data container: a gzipped tar, base64. */
  files: z.string(),
  keychain: z.object({ metadatakeys: Rows, genp: Rows, inet: Rows, cert: Rows, keys: Rows }),
});
type IosState = z.infer<typeof IosState>;

const CONTAINER_METADATA = '.com.apple.mobile_container_manager.metadata.plist';
/** Purgeable or regenerated on launch; the container's own metadata belongs to the device. Left out of a capture and of what a restore unpacks. */
const EXCLUDED = ['./tmp', './Library/Caches', './Library/SplashBoard', './Library/Saved Application State', `./${CONTAINER_METADATA}`, `./${STAGING}`].flatMap((entry) => ['--exclude', entry]);
const PREFERENCES_DAEMON = 'com.apple.cfprefsd.xpc.daemon';
const KEYCHAIN_DAEMON = 'com.apple.securityd';
/** How long the keychain write and the daemon restart after it may take, the launchd wait included. */
const COMMIT_TIMEOUT_MS = 30_000;

const SimulatorList = z.object({ devices: z.record(z.string(), z.array(z.object({ udid: z.string(), dataPath: z.string().optional() }))) });

const simctl = (step: string, args: readonly string[], options: RunOptions) => run(step, 'xcrun', ['simctl', ...args], options);

async function simulatorPaths(target: StateTarget, signal: AbortSignal): Promise<{ container: string; keychain: string }> {
  const listed = SimulatorList.parse(JSON.parse((await simctl('finding the simulator', ['list', 'devices', '-j'], { signal })).toString('utf8')));
  const device = Object.values(listed.devices).flat().find((entry) => entry.udid === target.deviceId);
  if (device?.dataPath === undefined) {
    throw unsupported(`a session can be saved on a local iOS simulator only, and ${target.deviceId} is not one`);
  }
  const container = (await simctl('finding the app data', ['get_app_container', target.deviceId, target.app, 'data'], { signal, allowFailure: true })).toString('utf8').trim();
  if (container === '') throw failure(`finding the app data: ${target.app} is not installed on ${target.deviceId}`);
  return { container, keychain: path.join(device.dataPath, 'Library', 'Keychains', 'keychain-2-debug.db') };
}

/** Exit 0 or not: an app that is not running has nothing left to write. */
const stopApp = (target: StateTarget, signal: AbortSignal) => simctl('stopping the app', ['terminate', target.deviceId, target.app], { signal, allowFailure: true });

/**
 * Restarts one of the simulator's daemons: SIGTERM, so it writes what it
 * holds, then a start that returns once it runs again. launchd keeps a daemon
 * down until 10 s after its last start, and an app launched meanwhile hangs
 * on it, so the wait belongs here and not in the test's first read.
 */
async function restartDaemon(step: string, target: StateTarget, label: string, signal: AbortSignal): Promise<void> {
  const launchctl = (...args: string[]) => simctl(step, ['spawn', target.deviceId, 'launchctl', ...args], { signal });
  const service = `user/${String(userInfo().uid)}/${label}`;
  const pid = Number((await launchctl('list')).toString('utf8').split('\n').find((line) => line.endsWith(`\t${label}`))?.split('\t')[0]);
  // Not running: it holds nothing, and starts fresh when something asks for it.
  if (!Number.isInteger(pid) || pid <= 0) return;
  await launchctl('kill', 'SIGTERM', service);
  const deadline = Date.now() + 5000;
  while (isRunning(pid)) {
    signal.throwIfAborted();
    if (Date.now() > deadline) throw failure(`${step}: the simulator's ${label} did not stop`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await launchctl('kickstart', service);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restarts the simulator's preferences daemon. It writes UserDefaults to disk
 * many seconds late and answers from its own cache, so a capture without
 * this misses a fresh write and a restore without it leaves the previous
 * user's defaults in force.
 */
const flushPreferences = (target: StateTarget, signal: AbortSignal) => restartDaemon('flushing preferences', target, PREFERENCES_DAEMON, signal);

/** The simulator's keychain database, through the host's sqlite3; `-safe` leaves it no way out of the database. `rowid` is the keychain's to assign. */
const keychainAt = (database: string, signal: AbortSignal) =>
  new SecureStore('keychain', (step, sql) => run(step, '/usr/bin/sqlite3', ['-safe', '-bail', '-cmd', '.timeout 5000', database], { signal, stdin: sql }), ['rowid']);

/** Items of the app's own access group, `<team>.<bundle id>`: a team id has no dot. */
const ownedBy = (app: string) => `instr(agrp, '.') > 1 and substr(agrp, instr(agrp, '.') + 1) = '${app}'`;
/** The same rule for a saved row, whose `agrp` is a quoted literal: a snapshot puts items in its own app's group and no other. */
function isOwnedBy(app: string, row: Row): boolean {
  const group = row['agrp'];
  return group !== undefined && group.startsWith("'") && group.indexOf('.') > 1 && group.slice(group.indexOf('.') + 1) === `${app}'`;
}
const EVERY_ROW = '1';

async function capture(target: StateTarget, signal: AbortSignal): Promise<IosState> {
  const paths = await simulatorPaths(target, signal);
  await stopApp(target, signal);
  await flushPreferences(target, signal);
  const archive = await run('reading the app data', '/usr/bin/tar', ['-C', paths.container, ...EXCLUDED, '-cf', '-', '.'], { signal });
  const keychain = keychainAt(paths.keychain, signal);
  const owned = ownedBy(target.app);
  const [metadatakeys, genp, inet, cert, keys] = await Promise.all([
    keychain.rows(KEYS_TABLE, EVERY_ROW),
    keychain.rows('genp', owned),
    keychain.rows('inet', owned),
    keychain.rows('cert', owned),
    keychain.rows('keys', owned),
  ]);
  return { platform: 'ios', app: target.app, files: await packFiles(archive), keychain: { metadatakeys, genp, inet, cert, keys } };
}

async function restore(target: StateTarget, data: unknown, signal: AbortSignal): Promise<void> {
  const saved = IosState.safeParse(data);
  if (!saved.success) throw invalidState('the saved session is not an iOS app state');
  const archive = await unpackFiles(saved.data.files);
  const paths = await simulatorPaths(target, signal);
  // Planned before the app is stopped: a snapshot this simulator's keychain cannot take is refused with the app untouched.
  const items = await keychainItems(target, keychainAt(paths.keychain, signal), saved.data.keychain);
  await stopApp(target, signal);
  // Before the files change: the daemon would otherwise write the previous user's defaults over the restored ones.
  await flushPreferences(target, signal);
  await replaceContainer(paths.container, archive, signal);
  // Not cut short by the test's deadline: new keys on disk beside a daemon that still holds the old ones
  // leave every item unreadable, and the next restore of this snapshot would find nothing to fix.
  const uninterrupted = AbortSignal.timeout(COMMIT_TIMEOUT_MS);
  await keychainAt(paths.keychain, uninterrupted).write(items.statements);
  if (items.foreign) await restartDaemon('writing the keychain', target, KEYCHAIN_DAEMON, uninterrupted);
}

/** Unpacks beside the files in place, which go only once their replacement is whole. */
async function replaceContainer(container: string, archive: Buffer, signal: AbortSignal): Promise<void> {
  const staging = path.join(container, STAGING);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging);
  try {
    await run('writing the app data', '/usr/bin/tar', ['-C', staging, ...EXCLUDED, '-xf', '-'], { signal, stdin: archive });
    await assertPlainTree(staging);
    // What a capture leaves out and an app expects to find.
    for (const directory of ['tmp', 'Library', path.join('Library', 'Caches')]) await ensureDirectory(path.join(staging, directory));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  const kept = new Set([CONTAINER_METADATA, STAGING]);
  await Promise.all((await readdir(container)).filter((entry) => !kept.has(entry)).map((entry) => rm(path.join(container, entry), { recursive: true, force: true })));
  await Promise.all((await readdir(staging)).map((entry) => rename(path.join(staging, entry), path.join(container, entry))));
  await rm(staging, { recursive: true });
}

/** A hard link joins a file outside the container to the app's data; a device node or a pipe is not data. */
async function assertPlainTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!entry.isFile() || (await lstat(path.join(entry.parentPath, entry.name))).nlink > 1) throw unreadableFiles();
  }
}

/** A symlink the archive put there would send the directory outside the container. */
async function ensureDirectory(directory: string): Promise<void> {
  const found = await lstat(directory).catch(() => undefined);
  if (found === undefined) await mkdir(directory);
  else if (!found.isDirectory()) throw unreadableFiles();
}

/**
 * The statements that put the saved items in place. A snapshot from this
 * simulator, or from one whose keys this one holds since an earlier restore,
 * replaces the app's items alone. Any other snapshot is `foreign`: it brings
 * its keys, and the items of every other app go with the old ones, since
 * nothing could read them again. That is `device.clearKeychain()` plus the
 * app's items, and the keychain daemon restarts to pick the keys up.
 */
export async function keychainItems(target: StateTarget, keychain: SecureStore, saved: IosState['keychain']): Promise<{ foreign: boolean; statements: string[] }> {
  if (ITEM_TABLES.some((table) => saved[table].some((row) => !isOwnedBy(target.app, row)))) {
    throw invalidState('the saved session holds keychain items of another app');
  }
  const [deviceKeys, schema] = await Promise.all([keychain.rows(KEYS_TABLE, EVERY_ROW), keychain.schema([KEYS_TABLE, ...ITEM_TABLES])]);
  const held = new Set(deviceKeys.map((row) => JSON.stringify(row)));
  const foreign = saved.metadatakeys.some((row) => !held.has(JSON.stringify(row)));
  const replaced = foreign ? EVERY_ROW : ownedBy(target.app);
  const statements = [
    ...(foreign ? [`delete from ${KEYS_TABLE};`, ...saved.metadatakeys.map((row) => insertRow(KEYS_TABLE, row, schema))] : []),
    ...ITEM_TABLES.flatMap((table) => [`delete from ${table} where ${replaced};`, ...saved[table].map((row) => insertRow(table, row, schema))]),
  ];
  return { foreign, statements };
}

export const ios: PlatformState = { capture, restore };
