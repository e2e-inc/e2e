/**
 * `device.addMedia`: photos and videos into the device's library, so a test
 * can pick them in the system photo picker. agent-device has no command for
 * it, so the engine runs the platform's own tool on this machine:
 * `xcrun simctl addmedia` for an iOS simulator, `adb push` and a media scan
 * for an Android device. That reaches only a device this machine drives
 * directly, so a physical iPhone, a device a provider leased, and a device
 * behind a remote agent-device daemon are refused before anything runs.
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { EngineError, TestError } from '@e2e-dev/core/engine';
import type { SlotBinding } from './bindings.ts';
import type { MobilePlatform } from './options.ts';
import { cancelled } from './support.ts';

/** One program the engine runs on this machine, with its arguments. */
export interface HostCommand {
  readonly file: string;
  readonly args: readonly string[];
}

/** How a host command runs: what unit tests script. Resolves to the program's stdout; rejects with its stderr on the error. */
export type HostRunner = (command: HostCommand, options: { readonly env: Readonly<Record<string, string | undefined>>; readonly signal: AbortSignal }) => Promise<string>;

/** The kinds agent-device boots a device as. */
export type DeviceKind = 'simulator' | 'emulator' | 'device';

/** Where an Android device keeps what `addMedia` pushes: shared storage the media provider indexes. */
const ANDROID_MEDIA_DIR = '/sdcard/Pictures';

/**
 * The most stderr a failure message carries. Longer output is left out
 * whole, never cut: the runner redacts whole secret values only, and half a
 * value no longer matches.
 */
const MAX_STDERR = 2_000;

/**
 * Runs a host command with `execFile`: no shell, so a file name is one
 * argument whatever it holds. An abort kills it with SIGKILL, which a
 * program cannot catch, and the promise settles once it has exited, so none
 * keeps working past the step. `execFile`'s own `signal` option sends
 * SIGTERM whatever `killSignal` says, so the abort is handled here.
 */
export const runHostCommand: HostRunner = (command, { env, signal }) =>
  new Promise((resolve, reject) => {
    const child = execFile(command.file, [...command.args], { env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) {
        reject(Object.assign(new Error(`${path.basename(command.file)} was stopped`), { name: 'AbortError' }));
        return;
      }
      if (error === null) {
        resolve(String(stdout));
        return;
      }
      const output = String(stderr).trim();
      reject(Object.assign(error, { stderr: output.length > MAX_STDERR ? `${output.length} characters of stderr, too long to show` : output }));
    });
    function kill(): void {
      child.kill('SIGKILL');
    }
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
  });

/** The files `device.addMedia` was given, as a list; anything but one or more non-empty strings is `INVALID_ARGUMENT`. */
export function mediaFiles(files: unknown): readonly string[] {
  // `Array.from` turns a hole into `undefined`, which `every` would otherwise skip.
  const list: unknown[] = typeof files === 'string' ? [files] : Array.isArray(files) ? Array.from(files as unknown[]) : [];
  if (list.length === 0 || !list.every((file): file is string => typeof file === 'string' && file !== '')) {
    throw new TestError('INVALID_ARGUMENT', 'device.addMedia takes a file path or a non-empty list of file paths');
  }
  return list;
}

/**
 * Throws `INVALID_ARGUMENT` for the first path that is not a readable file,
 * and on Android for a name the device would not keep: two names that differ
 * at most in case (shared storage ignores case, so the second would replace
 * the first), or a name starting with a dot, which the media scanner treats
 * as hidden and leaves out of the library.
 */
export async function assertMediaFiles(platform: MobilePlatform, files: readonly string[]): Promise<readonly number[]> {
  if (platform === 'android') {
    const names = new Set<string>();
    for (const file of files) {
      const name = path.basename(file);
      if (name.startsWith('.')) throw new TestError('INVALID_ARGUMENT', `device.addMedia: Android leaves ${name} out of the library, since a name starting with a dot is hidden; rename it`);
      const key = name.toLowerCase();
      if (names.has(key)) throw new TestError('INVALID_ARGUMENT', `device.addMedia: two files are named ${name}, ignoring case; Android keeps them under their names in ${ANDROID_MEDIA_DIR}, which ignores case, so rename one`);
      names.add(key);
    }
  }
  const sizes: number[] = [];
  for (const file of files) {
    const info = await stat(file).catch(() => undefined);
    const readable = info?.isFile() === true && (await access(file, constants.R_OK).then(() => true, () => false));
    if (!readable || info === undefined) throw new TestError('INVALID_ARGUMENT', `device.addMedia: ${file} is not a readable file`);
    sizes.push(info.size);
  }
  return sizes;
}

/**
 * Why this machine cannot reach the device's library, or `undefined` when it
 * can: the slot rides another daemon or a provider's lease, the environment
 * points agent-device at a remote daemon, or the device is a physical iPhone,
 * whose photo library no command-line tool writes.
 */
export function mediaRefusal(
  platform: MobilePlatform,
  kind: DeviceKind | undefined,
  binding: SlotBinding | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const tool = platform === 'ios' ? 'xcrun simctl addmedia' : 'adb push';
  if (binding?.daemon !== undefined || binding?.leaseId !== undefined || binding?.client !== undefined) {
    return `device.addMedia runs ${tool} on this machine, and this device is driven through a device provider or another agent-device daemon; add the media through the provider instead`;
  }
  if ((env['AGENT_DEVICE_DAEMON_BASE_URL'] ?? '') !== '') {
    return `device.addMedia runs ${tool} on this machine, and AGENT_DEVICE_DAEMON_BASE_URL points agent-device at a remote daemon, whose devices this machine cannot reach`;
  }
  if (platform === 'ios' && kind === 'device') {
    return 'device.addMedia adds to an iOS simulator\'s library with xcrun simctl addmedia; no tool adds photos to a physical iPhone, so add them on the phone';
  }
  return undefined;
}

/** The variable agent-device's daemon reads for the CoreSimulator device set it keeps its simulators in. */
const SIMULATOR_SET_VARIABLE = 'AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET';

/**
 * The commands that add `files` to the library of the device with id
 * `deviceId`. iOS takes them in one `simctl addmedia`, which adds a copy on
 * every call, in the device set `AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET` names,
 * as agent-device's own simctl calls do. Android pushes each file to
 * `ANDROID_MEDIA_DIR` under its own name, replacing a file of that name,
 * then asks the media scanner for it. The scan is needed on every version:
 * Android 10 and earlier index only what is scanned, and Android 11 and later
 * usually index a pushed file on their own but not always (seen on API 36
 * with a name that differs only in case from the file it replaced, and with
 * a name holding `:` or `?`).
 */
export function mediaCommands(
  platform: MobilePlatform,
  deviceId: string,
  files: readonly string[],
  adb: string,
  env: Readonly<Record<string, string | undefined>>,
): readonly HostCommand[] {
  if (platform === 'ios') {
    const set = env[SIMULATOR_SET_VARIABLE]?.trim();
    return [{ file: 'xcrun', args: ['simctl', ...(set ? ['--set', set] : []), 'addmedia', deviceId, ...files] }];
  }
  return files.flatMap((file) => {
    const name = path.basename(file);
    const remote = `${ANDROID_MEDIA_DIR}/${name}`;
    return [
      { file: adb, args: ['-s', deviceId, 'push', file, remote] },
      // `adb shell` hands its arguments to the device's shell: the URI is percent-encoded, so the quotes hold whatever the name contains.
      { file: adb, args: ['-s', deviceId, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `'file://${ANDROID_MEDIA_DIR}/${encodeName(name)}'`] },
    ];
  });
}

/**
 * Lists the photos and videos (`media_type` 1 and 3) the media index keeps
 * under a `Pictures` directory, with their sizes, for `unindexedFiles`. The
 * `where` clause names no file, so the device's shell reads only fixed text.
 */
export function androidIndexQuery(deviceId: string, adb: string): HostCommand {
  return {
    file: adb,
    args: ['-s', deviceId, 'shell', 'content', 'query', '--uri', 'content://media/external/file', '--projection', '_data:_size', '--where', `"_data LIKE '%/Pictures/%' AND media_type IN (1, 3)"`],
  };
}

/** Where the primary shared storage keeps `ANDROID_MEDIA_DIR` in the index: `/sdcard` is `/storage/emulated/<user>`. */
const INDEXED_MEDIA_PATH = /^\/storage\/emulated\/\d+\/Pictures\/([^/]+)$/;

/** One `content query` row of `androidIndexQuery`: the path, then the size, `NULL` until the scan has measured it. */
const INDEX_ROW = /_data=(.*), _size=(\S+)\s*$/;

/**
 * The files whose pushed copy `androidIndexQuery`'s output does not list
 * yet, as a photo or video at its place in `ANDROID_MEDIA_DIR` with the size
 * of the local file. The media scan a broadcast asks for runs after
 * `am broadcast` returns, so a file can be missing, or still listed with the
 * size of the file it replaced, for a moment. Names compare ignoring case,
 * as the storage does: a push over `RECEIPT.png` keeps that spelling.
 */
export function unindexedFiles(stdout: string, files: readonly string[], sizes: readonly number[]): readonly string[] {
  const rows = stdout.split('\n').flatMap((line) => {
    const row = INDEX_ROW.exec(line);
    const place = row === null ? null : INDEXED_MEDIA_PATH.exec(row[1]!);
    return row === null || place === null ? [] : [{ name: place[1]!.toLowerCase(), size: Number(row[2]) }];
  });
  return files.filter((file, index) => !rows.some((row) => row.name === path.basename(file).toLowerCase() && row.size === sizes[index]));
}

/** A file name as one percent-encoded URI path segment, with none of the characters `encodeURIComponent` leaves bare that a shell reads. */
function encodeName(name: string): string {
  return encodeURIComponent(name).replaceAll(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The adb agent-device would run: `platform-tools/adb` under
 * `ANDROID_SDK_ROOT`, `ANDROID_HOME`, the macOS default SDK, or
 * `~/Android/Sdk`, the first that is executable, else `adb` on `PATH`. The
 * same binary keeps the adb server agent-device started running, since a
 * client of another version restarts it.
 */
export async function findAdb(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): Promise<string> {
  const home = env['HOME']?.trim();
  const roots = [
    env['ANDROID_SDK_ROOT']?.trim(),
    env['ANDROID_HOME']?.trim(),
    platform === 'darwin' && home ? path.join(home, 'Library', 'Android', 'sdk') : undefined,
    home ? path.join(home, 'Android', 'Sdk') : undefined,
  ];
  for (const root of roots) {
    if (!root) continue;
    const adb = path.join(root, 'platform-tools', platform === 'win32' ? 'adb.exe' : 'adb');
    if (await access(adb, constants.X_OK).then(() => true, () => false)) return adb;
  }
  return 'adb';
}

/**
 * Translates a host command's failure: the step's own abort is `CANCELLED`,
 * the action timeout `OPERATION_TIMEOUT`, a missing program or any other
 * failure `ENGINE_FAILURE` with what it wrote.
 */
export function hostCommandError(error: unknown, command: HostCommand, stop: { readonly cancelled: boolean; readonly timedOutAfterMs?: number | undefined }): EngineError {
  const shown = `${path.basename(command.file)} ${command.args.slice(0, 3).join(' ')}`;
  if (stop.cancelled) return cancelled(`device.addMedia was cancelled while ${shown} ran`);
  // No `cause`: the child-process error carries the command line and stderr in fields the runner does not redact.
  if (stop.timedOutAfterMs !== undefined) {
    return new EngineError('OPERATION_TIMEOUT', `device.addMedia stopped ${shown} after ${stop.timedOutAfterMs}ms, the action timeout`, { retryable: false });
  }
  const { code, stderr } = (error ?? {}) as { code?: unknown; stderr?: unknown };
  if (code === 'ENOENT') {
    const hint = command.file === 'xcrun' ? 'install Xcode and its command-line tools' : 'install the Android SDK platform-tools, or set ANDROID_HOME';
    return new EngineError('ENGINE_FAILURE', `device.addMedia could not run ${command.file}: ${hint}`, { retryable: false });
  }
  const detail = typeof stderr === 'string' && stderr !== '' ? stderr : error instanceof Error ? error.message : String(error);
  return new EngineError('ENGINE_FAILURE', `device.addMedia: ${shown} failed: ${detail}`, { retryable: false });
}
