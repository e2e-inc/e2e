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

/** How a host command runs: what unit tests script. Rejects with the program's stderr in the message. */
export type HostRunner = (command: HostCommand, options: { readonly env: Readonly<Record<string, string | undefined>>; readonly signal: AbortSignal }) => Promise<void>;

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

/** Runs a host command with `execFile`: no shell, so a file name is one argument whatever it holds. */
export const runHostCommand: HostRunner = (command, { env, signal }) =>
  new Promise((resolve, reject) => {
    execFile(command.file, [...command.args], { env, signal, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve();
        return;
      }
      const output = String(stderr).trim();
      reject(Object.assign(error, { stderr: output.length > MAX_STDERR ? `${output.length} characters of stderr, too long to show` : output }));
    });
  });

/** The files `device.addMedia` was given, as a list; anything but one or more non-empty strings is `INVALID_ARGUMENT`. */
export function mediaFiles(files: unknown): readonly string[] {
  const list: unknown[] = typeof files === 'string' ? [files] : Array.isArray(files) ? files : [];
  if (list.length === 0 || !list.every((file): file is string => typeof file === 'string' && file !== '')) {
    throw new TestError('INVALID_ARGUMENT', 'device.addMedia takes a file path or a non-empty list of file paths');
  }
  return list;
}

/** Throws `INVALID_ARGUMENT` for the first path that is not a readable file. */
export async function assertMediaFiles(files: readonly string[]): Promise<void> {
  for (const file of files) {
    const info = await stat(file).catch(() => undefined);
    const readable = info?.isFile() === true && (await access(file, constants.R_OK).then(() => true, () => false));
    if (!readable) throw new TestError('INVALID_ARGUMENT', `device.addMedia: ${file} is not a readable file`);
  }
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
  envs: readonly Readonly<Record<string, string | undefined>>[],
): string | undefined {
  const tool = platform === 'ios' ? 'xcrun simctl addmedia' : 'adb push';
  if (binding?.daemon !== undefined || binding?.leaseId !== undefined || binding?.client !== undefined) {
    return `device.addMedia runs ${tool} on this machine, and this device is driven through a device provider or another agent-device daemon; add the media through the provider instead`;
  }
  // The worker's environment and the process's own: agent-device's client can read either.
  if (envs.some((env) => (env['AGENT_DEVICE_DAEMON_BASE_URL'] ?? '') !== '')) {
    return `device.addMedia runs ${tool} on this machine, and AGENT_DEVICE_DAEMON_BASE_URL points agent-device at a remote daemon, whose devices this machine cannot reach`;
  }
  if (platform === 'ios' && kind === 'device') {
    return 'device.addMedia adds to an iOS simulator\'s library with xcrun simctl addmedia; no tool adds photos to a physical iPhone, so add them on the phone';
  }
  return undefined;
}

/**
 * The commands that add `files` to the library of the device with id
 * `deviceId`. iOS takes them in one `simctl addmedia`, which adds a copy on
 * every call. Android pushes each file to `ANDROID_MEDIA_DIR` under its own
 * name, replacing a file of that name, then asks the media scanner for it:
 * Android 11 and later index a pushed file on their own, and earlier versions
 * index only what is scanned.
 */
export function mediaCommands(platform: MobilePlatform, deviceId: string, files: readonly string[], adb: string): readonly HostCommand[] {
  if (platform === 'ios') return [{ file: 'xcrun', args: ['simctl', 'addmedia', deviceId, ...files] }];
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
  if (stop.timedOutAfterMs !== undefined) {
    return new EngineError('OPERATION_TIMEOUT', `device.addMedia stopped ${shown} after ${stop.timedOutAfterMs}ms, the action timeout`, { retryable: false, cause: error });
  }
  const { code, stderr } = (error ?? {}) as { code?: unknown; stderr?: unknown };
  if (code === 'ENOENT') {
    const hint = command.file === 'xcrun' ? 'install Xcode and its command-line tools' : 'install the Android SDK platform-tools, or set ANDROID_HOME';
    return new EngineError('ENGINE_FAILURE', `device.addMedia could not run ${command.file}: ${hint}`, { retryable: false, cause: error });
  }
  const detail = typeof stderr === 'string' && stderr !== '' ? stderr : error instanceof Error ? error.message : String(error);
  return new EngineError('ENGINE_FAILURE', `device.addMedia: ${shown} failed: ${detail}`, { retryable: false, cause: error });
}
