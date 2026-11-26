/**
 * `device.addMedia`: the programs it runs on this machine for each platform,
 * what it refuses before running any, and how a program's failure reads.
 * The host runner is scripted, so no simulator or adb is needed.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { obj, type EngineFixtureContext, type FixtureOperations } from '@e2e-dev/core/engine';
import type { Device } from '../../src/device.ts';
import { buildEngine } from '../../src/engine.ts';
import { findAdb, mediaCommands, mediaRefusal, runHostCommand, type HostCommand, type HostRunner } from '../../src/media.ts';
import type { MobileOptions } from '../../src/options.ts';
import { AgentDeviceSurface } from '../../src/surface.ts';
import { createFakeClient, SETTINGS_SNAPSHOT } from '../helpers/fake-client.ts';

let dir: string;

/** The file name `findAdb` looks for on this machine. */
const ADB_NAME = process.platform === 'win32' ? 'adb.exe' : 'adb';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'e2e-add-media-'));
  // addMedia reads this process's environment, as agent-device does; a developer's shell must not leak into it.
  for (const name of ['AGENT_DEVICE_DAEMON_BASE_URL', 'AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET', 'ANDROID_SDK_ROOT', 'ANDROID_HOME']) vi.stubEnv(name, '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

interface Setup {
  readonly device: Device;
  readonly ran: HostCommand[];
  readonly env: Readonly<Record<string, string | undefined>>[];
  readonly labels: () => FixtureOperations<Device> | undefined;
}

/** A host runner that also sees what ran before, so it can answer an index query from the pushes. */
type ScriptedRunner = (command: HostCommand, call: Parameters<HostRunner>[1], ran: readonly HostCommand[]) => Promise<string>;

/** The `content query` rows an Android index lists for the files pushed so far, as the device prints them. */
function indexRows(ran: readonly HostCommand[]): string {
  const pushed = ran
    .filter((command) => command.args[2] === 'push')
    .map((command) => ({ path: command.args[4]!.replace('/sdcard/', '/storage/emulated/0/'), size: statSync(command.args[3]!).size }));
  return pushed.length === 0 ? 'No result found.\n' : pushed.map(({ path: remote, size }, row) => `Row: ${row} _data=${remote}, _size=${size}\n`).join('');
}

/** The size `photo()` writes. */
const PHOTO_SIZE = 'not really a jpeg'.length;

/** A device that indexes every pushed file as soon as it lands, as Android 11 and later do. */
const indexesAtOnce: ScriptedRunner = async (command, _call, ran) => (command.args.includes('content') ? indexRows(ran) : '');

/** Boots an engine on a device agent-device reports as `kind`, and returns its `device` fixture with every host command recorded. */
async function setup(
  options: Partial<MobileOptions> & { kind: 'simulator' | 'emulator' | 'device'; id: string },
  runner: ScriptedRunner = indexesAtOnce,
  signal = new AbortController().signal,
  actionTimeout = 5_000,
): Promise<Setup> {
  const { kind, id, ...engineOptions } = options;
  const fake = createFakeClient({
    'devices.boot': () => ({ id, device: 'Test device', kind, platform: engineOptions.platform ?? 'ios', booted: true }),
    'capture.snapshot': () => SETTINGS_SNAPSHOT,
  });
  const ran: HostCommand[] = [];
  const envs: Readonly<Record<string, string | undefined>>[] = [];
  const surface = new AgentDeviceSurface({ platform: 'ios', ...engineOptions }, () => fake.client, async (command, call) => {
    ran.push(command);
    envs.push(call.env);
    return runner(command, call, ran);
  });
  const engine = buildEngine(surface);
  await engine.init!({
    runId: 'run-1',
    targetName: 'target',
    projectRoot: dir,
    app: {},
    env: {},
    headed: false,
    workerSlot: 0,
    log: () => undefined,
    signal: new AbortController().signal,
  });
  let declared: FixtureOperations<Device> | undefined;
  const context = {
    targetName: 'target',
    fixture: (_name: string, value: object, operations: FixtureOperations<Device>) => {
      declared = operations;
      return value;
    },
    signal,
    headed: false,
    timeouts: { test: 30_000, action: actionTimeout, assertion: 5_000 },
    operation: () => ({ signal, timeoutMs: 5_000, runId: 'run-1', attemptId: 'a1', origin: 'test' }),
    locator: () => ({}),
  } as unknown as EngineFixtureContext;
  const device = engine.fixtures!['device']!(context) as Device;
  return { device, ran, env: envs, labels: () => declared };
}

function photo(name: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, 'not really a jpeg');
  return file;
}

describe('device.addMedia', () => {
  it("adds every file to an iOS simulator in one simctl addmedia, paths resolved against the project root, with this process's environment", async () => {
    photo('receipt.jpg');
    mkdirSync(path.join(dir, 'media'));
    photo('media/clip.mov');
    const { device, ran, env } = await setup({ platform: 'ios', kind: 'simulator', id: 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0' });
    await device.addMedia(['receipt.jpg', 'media/clip.mov']);
    expect(ran).toEqual([
      { file: 'xcrun', args: ['simctl', 'addmedia', 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0', path.join(dir, 'receipt.jpg'), path.join(dir, 'media', 'clip.mov')] },
    ]);
    // The environment the agent-device client and its daemon read, so the program reaches the same adb server and simulator set.
    expect(env).toEqual([process.env]);
  });

  it('adds to the simulator set agent-device keeps its simulators in', async () => {
    const file = photo('receipt.jpg');
    vi.stubEnv('AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET', '/tmp/e2e-simulators');
    const { device, ran } = await setup({ platform: 'ios', kind: 'simulator', id: 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0' });
    await device.addMedia(file);
    expect(ran).toEqual([{ file: 'xcrun', args: ['simctl', '--set', '/tmp/e2e-simulators', 'addmedia', 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0', file] }]);
  });

  it('pushes each file to an Android device under its own name, then scans it, with the SDK adb', async () => {
    const file = photo("it's 100% (1).png");
    const sdk = path.join(dir, 'sdk');
    mkdirSync(path.join(sdk, 'platform-tools'), { recursive: true });
    const adb = path.join(sdk, 'platform-tools', ADB_NAME);
    writeFileSync(adb, '');
    chmodSync(adb, 0o755);
    vi.stubEnv('ANDROID_HOME', sdk);
    const { device, ran } = await setup({ platform: 'android', kind: 'emulator', id: 'emulator-5554', device: 'emulator-5554' });
    await device.addMedia(file);
    expect(ran).toEqual([
      { file: adb, args: ['-s', 'emulator-5554', 'push', file, "/sdcard/Pictures/it's 100% (1).png"] },
      {
        file: adb,
        args: ['-s', 'emulator-5554', 'shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', "'file:///sdcard/Pictures/it%27s%20100%25%20%281%29.png'"],
      },
      {
        file: adb,
        args: [
          '-s',
          'emulator-5554',
          'shell',
          'content',
          'query',
          '--uri',
          'content://media/external/file',
          '--projection',
          '_data:_size',
          '--where',
          `"_data LIKE '%/Pictures/%' AND media_type IN (1, 3)"`,
        ],
      },
    ]);
  });

  it('waits until the media index lists every pushed file, as on Android 10, where the scan finishes after the broadcast', async () => {
    photo('a.jpg');
    photo('b.jpg');
    let queries = 0;
    const { device, ran } = await setup({ platform: 'android', kind: 'emulator', id: 'emulator-5554' }, async (command, _call, done) => {
      if (!command.args.includes('content')) return '';
      queries += 1;
      // The first answer lists only a.jpg; b.jpg is still being scanned.
      return queries === 1 ? `Row: 0 _data=/storage/emulated/0/Pictures/a.jpg, _size=${PHOTO_SIZE}\n` : indexRows(done);
    });
    await device.addMedia(['a.jpg', 'b.jpg']);
    expect(queries).toBe(2);
    expect(ran.filter((command) => command.args.includes('content'))).toHaveLength(2);
  });

  it('takes only the pushed file as indexed: its place in Pictures on primary storage and its size, with the name in any case', async () => {
    photo('receipt.jpg');
    const answers = [
      // Another album, and another volume, with a file of the same name.
      `Row: 0 _data=/storage/emulated/0/Download/Pictures/receipt.jpg, _size=${PHOTO_SIZE}\nRow: 1 _data=/storage/1A2B-3C4D/Pictures/receipt.jpg, _size=${PHOTO_SIZE}\n`,
      // The file this call replaced, not scanned again yet: its old size, or none.
      'Row: 0 _data=/storage/emulated/0/Pictures/receipt.jpg, _size=393493\n',
      'Row: 0 _data=/storage/emulated/0/Pictures/receipt.jpg, _size=NULL\n',
      // Scanned: the storage kept the earlier file's spelling, RECEIPT.JPG.
      `Row: 0 _data=/storage/emulated/0/Pictures/RECEIPT.JPG, _size=${PHOTO_SIZE}\n`,
    ];
    let queries = 0;
    const { device } = await setup({ platform: 'android', kind: 'emulator', id: 'emulator-5554' }, async (command) =>
      command.args.includes('content') ? answers[Math.min(queries++, answers.length - 1)]! : '',
    );
    await device.addMedia('receipt.jpg');
    expect(queries).toBe(answers.length);
  });

  it('stops waiting for the media index at the action timeout', async () => {
    photo('a.jpg');
    const { device } = await setup(
      { platform: 'android', kind: 'emulator', id: 'emulator-5554' },
      async (command) => (command.args.includes('content') ? 'No result found.\n' : ''),
      new AbortController().signal,
      300,
    );
    await expect(device.addMedia('a.jpg')).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('adds to a physical Android phone too, which adb reaches like an emulator', async () => {
    const file = photo('a.jpg');
    const { device, ran } = await setup({ platform: 'android', kind: 'device', id: 'R58M123ABC' });
    await device.addMedia(file);
    expect(ran.map((command) => command.args.slice(0, 4))).toEqual([
      ['-s', 'R58M123ABC', 'push', file],
      ['-s', 'R58M123ABC', 'shell', 'am'],
      ['-s', 'R58M123ABC', 'shell', 'content'],
    ]);
  });

  it('refuses a physical iPhone and a remote daemon before checking the files or running anything', async () => {
    const iphone = await setup({ platform: 'ios', kind: 'device', id: '00008110-000A1C2E3C6B801E' });
    await expect(iphone.device.addMedia('missing.jpg')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('physical iPhone') });
    expect(iphone.ran).toEqual([]);

    vi.stubEnv('AGENT_DEVICE_DAEMON_BASE_URL', 'https://devices.example.com');
    const remote = await setup({ platform: 'android', kind: 'emulator', id: 'emulator-5554' });
    await expect(remote.device.addMedia('missing.jpg')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('AGENT_DEVICE_DAEMON_BASE_URL') });
    expect(remote.ran).toEqual([]);
  });

  it('refuses a device a provider leased or another daemon drives', () => {
    expect(mediaRefusal('android', 'emulator', { daemon: { baseUrl: 'http://127.0.0.1:4310' } }, {})).toContain('device provider');
    expect(mediaRefusal('ios', 'simulator', { leaseId: 'lease-1' }, {})).toContain('device provider');
    expect(mediaRefusal('ios', 'simulator', { client: obj({ stateDir: '/tmp/state' }) }, {})).toContain('device provider');
    expect(mediaRefusal('ios', 'simulator', { deviceId: 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0' }, { AGENT_DEVICE_DAEMON_BASE_URL: '' })).toBeUndefined();
    expect(mediaRefusal('android', 'device', undefined, {})).toBeUndefined();
  });

  it('is INVALID_ARGUMENT for a missing file, a directory, or no paths, before running anything', async () => {
    mkdirSync(path.join(dir, 'folder'));
    const { device, ran } = await setup({ platform: 'ios', kind: 'simulator', id: 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0' });
    await expect(device.addMedia('missing.jpg')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining(path.join(dir, 'missing.jpg')) });
    await expect(device.addMedia('folder')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(device.addMedia([])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(device.addMedia(['ok.jpg', ''])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(device.addMedia(42 as unknown as string)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    // A list with a hole: `every` skips it, and on Android the name check then fails with a TypeError on `undefined`.
    const holes: string[] = [];
    holes.length = 1;
    const android = await setup({ platform: 'android', kind: 'emulator', id: 'emulator-5554' });
    await expect(android.device.addMedia(holes)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(android.ran).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('is INVALID_ARGUMENT on Android for two files with one name, which would land on the same path; iOS adds both', async () => {
    mkdirSync(path.join(dir, 'a'));
    mkdirSync(path.join(dir, 'b'));
    photo('a/photo.jpg');
    photo('b/photo.jpg');
    photo('b/PHOTO.jpg');
    photo('.hidden.jpg');
    const android = await setup({ platform: 'android', kind: 'emulator', id: 'emulator-5554' });
    await expect(android.device.addMedia(['a/photo.jpg', 'b/photo.jpg'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('two files are named photo.jpg') });
    // Android's shared storage ignores case, so these land on one file too.
    await expect(android.device.addMedia(['a/photo.jpg', 'b/PHOTO.jpg'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('ignoring case') });
    // The media scanner treats a dot file as hidden and leaves it out of the library.
    await expect(android.device.addMedia('.hidden.jpg')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('starting with a dot') });
    expect(android.ran).toEqual([]);
    const ios = await setup({ platform: 'ios', kind: 'simulator', id: 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0' });
    await ios.device.addMedia(['a/photo.jpg', 'b/photo.jpg']);
    expect(ios.ran).toHaveLength(1);
  });

  it("reports the program's stderr as ENGINE_FAILURE, a missing program with how to install it, and stops at the first failure", async () => {
    photo('a.jpg');
    photo('b.jpg');
    const failing = await setup({ platform: 'android', kind: 'emulator', id: 'emulator-5554' }, async () => {
      throw Object.assign(new Error('Command failed'), { code: 1, stderr: "adb: error: failed to get feature set: device 'emulator-5554' not found" });
    });
    const error: unknown = await failing.device.addMedia(['a.jpg', 'b.jpg']).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining("device 'emulator-5554' not found") });
    // The child-process error keeps the command line and stderr in fields the runner does not redact, so it is not the cause.
    expect((error as Error).cause).toBeUndefined();
    expect(failing.ran).toHaveLength(1);

    const missing = await setup({ platform: 'ios', kind: 'simulator', id: 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0' }, async () => {
      throw Object.assign(new Error('spawn xcrun ENOENT'), { code: 'ENOENT' });
    });
    await expect(missing.device.addMedia('a.jpg')).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('install Xcode') });
  });

  it('is CANCELLED when the step is aborted while a program runs', async () => {
    photo('a.jpg');
    const controller = new AbortController();
    const { device } = await setup(
      { platform: 'ios', kind: 'simulator', id: 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0' },
      async () => {
        controller.abort();
        throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      },
      controller.signal,
    );
    await expect(device.addMedia('a.jpg')).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('starts no program once the step is stopped, even when that happened while the files were checked', async () => {
    photo('a.jpg');
    const controller = new AbortController();
    controller.abort();
    const { device, ran } = await setup({ platform: 'ios', kind: 'simulator', id: 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0' }, undefined, controller.signal);
    await expect(device.addMedia('a.jpg')).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(ran).toEqual([]);
  });

  // The engine's OPERATION_TIMEOUT; a test sees the runner's ACTION_FAILED, which wraps every device step.
  it('kills a program that outlives the action timeout, and runs nothing after it', async () => {
    photo('a.jpg');
    photo('b.jpg');
    const { device, ran } = await setup(
      { platform: 'android', kind: 'emulator', id: 'emulator-5554' },
      (_command, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('killed'), { name: 'AbortError' })), { once: true });
        }),
      new AbortController().signal,
      50,
    );
    await expect(device.addMedia(['a.jpg', 'b.jpg'])).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', message: expect.stringContaining('50ms') });
    expect(ran).toHaveLength(1);
  });

  it('labels the step with the file names, never their directories', async () => {
    const { labels } = await setup({ platform: 'ios', kind: 'simulator', id: 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0' });
    const label = labels()?.addMedia?.label;
    expect(label?.('/Users/someone/receipt.jpg')).toBe('receipt.jpg');
    expect(label?.(['a/1.jpg', 'b/2.jpg', 'c/3.jpg'])).toBe('1.jpg, 2.jpg, 3.jpg');
    expect(label?.(['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'])).toBe('1.jpg, 2.jpg and 3 more');
  });
});

describe('runHostCommand', () => {
  const failWith = (stderr: number): HostCommand => ({
    file: process.execPath,
    args: ['-e', `process.stderr.write('k'.repeat(${stderr})); process.exit(3)`],
  });
  const stderrOf = (command: HostCommand): Promise<unknown> =>
    runHostCommand(command, { env: process.env, signal: new AbortController().signal }).then(
      () => undefined,
      (error: { stderr?: unknown }) => error.stderr,
    );

  it('kills a program that ignores SIGTERM when the signal aborts, so it does not keep working', async () => {
    const pidFile = path.join(dir, 'pid');
    const ignoresTerm: HostCommand = {
      file: process.execPath,
      // The pid file goes in as an argument (process.argv[1] under `-e`), never into the code.
      args: ['-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30_000)", pidFile],
    };
    const controller = new AbortController();
    const running = runHostCommand(ignoresTerm, { env: process.env, signal: controller.signal });
    await expect.poll(() => existsSync(pidFile), { timeout: 10_000 }).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await expect.poll(alive, { timeout: 1_000 }).toBe(false);
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL');
    }
  });

  it("rejects with the program's stderr, and leaves out stderr too long to show instead of cutting it", async () => {
    expect(await stderrOf(failWith(12))).toBe('k'.repeat(12));
    // Half a secret no longer matches the redactor, so long output is dropped whole.
    expect(await stderrOf(failWith(5_000))).toBe('5000 characters of stderr, too long to show');
  });
});

describe('mediaCommands', () => {
  it('runs no program for an empty list on Android, and one simctl call on iOS', () => {
    expect(mediaCommands('android', 'emulator-5554', [], 'adb', {})).toEqual([]);
    expect(mediaCommands('ios', 'UDID', ['/a.jpg'], 'adb', { AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET: ' ' })).toEqual([{ file: 'xcrun', args: ['simctl', 'addmedia', 'UDID', '/a.jpg'] }]);
  });
});

describe('findAdb', () => {
  // Windows has no execute bit, so a plain file there counts as executable.
  it.skipIf(process.platform === 'win32')('takes the first SDK root with an executable adb, else adb on PATH', async () => {
    const root = (name: string, executable: boolean): string => {
      const sdk = path.join(dir, name);
      mkdirSync(path.join(sdk, 'platform-tools'), { recursive: true });
      const adb = path.join(sdk, 'platform-tools', 'adb');
      writeFileSync(adb, '');
      chmodSync(adb, executable ? 0o755 : 0o644);
      return sdk;
    };
    const plain = root('plain', false);
    const home = root('home', true);
    expect(await findAdb({ ANDROID_SDK_ROOT: plain, ANDROID_HOME: home }, 'linux')).toBe(path.join(home, 'platform-tools', 'adb'));
    expect(await findAdb({ ANDROID_SDK_ROOT: plain }, 'linux')).toBe('adb');
    mkdirSync(path.join(dir, 'user', 'Library', 'Android'), { recursive: true });
    const mac = root(path.join('user', 'Library', 'Android', 'sdk'), true);
    expect(await findAdb({ HOME: path.join(dir, 'user') }, 'darwin')).toBe(path.join(mac, 'platform-tools', 'adb'));
    expect(await findAdb({ HOME: path.join(dir, 'user') }, 'linux')).toBe('adb');
  });
});
