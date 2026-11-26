/**
 * `device.addMedia`: the programs it runs on this machine for each platform,
 * what it refuses before running any, and how a program's failure reads.
 * The host runner is scripted, so no simulator or adb is needed.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Setup {
  readonly device: Device;
  readonly ran: HostCommand[];
  readonly env: Readonly<Record<string, string | undefined>>[];
  readonly labels: () => FixtureOperations<Device> | undefined;
}

/** Boots an engine on a device agent-device reports as `kind`, and returns its `device` fixture with every host command recorded. */
async function setup(
  options: Partial<MobileOptions> & { kind: 'simulator' | 'emulator' | 'device'; id: string },
  runner: HostRunner = async () => undefined,
  env: Readonly<Record<string, string | undefined>> = {},
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
    await runner(command, call);
  });
  const engine = buildEngine(surface);
  await engine.init!({
    runId: 'run-1',
    targetName: 'target',
    projectRoot: dir,
    app: {},
    env,
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
  it('adds every file to an iOS simulator in one simctl addmedia, paths resolved against the project root, with the worker environment', async () => {
    photo('receipt.jpg');
    mkdirSync(path.join(dir, 'media'));
    photo('media/clip.mov');
    const { device, ran, env } = await setup({ platform: 'ios', kind: 'simulator', id: 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0' }, undefined, { PATH: '/usr/bin' });
    await device.addMedia(['receipt.jpg', 'media/clip.mov']);
    expect(ran).toEqual([
      { file: 'xcrun', args: ['simctl', 'addmedia', 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0', path.join(dir, 'receipt.jpg'), path.join(dir, 'media', 'clip.mov')] },
    ]);
    expect(env).toEqual([{ PATH: '/usr/bin' }]);
  });

  it('pushes each file to an Android device under its own name, then scans it, with the SDK adb', async () => {
    const file = photo("it's 100% (1).png");
    const sdk = path.join(dir, 'sdk');
    mkdirSync(path.join(sdk, 'platform-tools'), { recursive: true });
    const adb = path.join(sdk, 'platform-tools', ADB_NAME);
    writeFileSync(adb, '');
    chmodSync(adb, 0o755);
    const { device, ran } = await setup({ platform: 'android', kind: 'emulator', id: 'emulator-5554', device: 'emulator-5554' }, undefined, { ANDROID_HOME: sdk });
    await device.addMedia(file);
    expect(ran).toEqual([
      { file: adb, args: ['-s', 'emulator-5554', 'push', file, "/sdcard/Pictures/it's 100% (1).png"] },
      {
        file: adb,
        args: ['-s', 'emulator-5554', 'shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', "'file:///sdcard/Pictures/it%27s%20100%25%20%281%29.png'"],
      },
    ]);
  });

  it('adds to a physical Android phone too, which adb reaches like an emulator', async () => {
    const file = photo('a.jpg');
    const { device, ran } = await setup({ platform: 'android', kind: 'device', id: 'R58M123ABC' });
    await device.addMedia(file);
    expect(ran.map((command) => command.args.slice(0, 3))).toEqual([
      ['-s', 'R58M123ABC', 'push'],
      ['-s', 'R58M123ABC', 'shell'],
    ]);
  });

  it('refuses a physical iPhone and a remote daemon before checking the files or running anything', async () => {
    const iphone = await setup({ platform: 'ios', kind: 'device', id: '00008110-000A1C2E3C6B801E' });
    await expect(iphone.device.addMedia('missing.jpg')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('physical iPhone') });
    expect(iphone.ran).toEqual([]);

    const remote = await setup({ platform: 'android', kind: 'emulator', id: 'emulator-5554' }, undefined, { AGENT_DEVICE_DAEMON_BASE_URL: 'https://devices.example.com' });
    await expect(remote.device.addMedia('missing.jpg')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('AGENT_DEVICE_DAEMON_BASE_URL') });
    expect(remote.ran).toEqual([]);
  });

  it('refuses a device a provider leased or another daemon drives', () => {
    expect(mediaRefusal('android', 'emulator', { daemon: { baseUrl: 'http://127.0.0.1:4310' } }, [{}])).toContain('device provider');
    expect(mediaRefusal('ios', 'simulator', { leaseId: 'lease-1' }, [{}])).toContain('device provider');
    expect(mediaRefusal('ios', 'simulator', { client: obj({ stateDir: '/tmp/state' }) }, [{}])).toContain('device provider');
    expect(mediaRefusal('ios', 'simulator', { deviceId: 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0' }, [{ AGENT_DEVICE_DAEMON_BASE_URL: '' }, {}])).toBeUndefined();
    // A remote daemon named in either environment: the worker's or the process's own.
    expect(mediaRefusal('android', 'emulator', undefined, [{}, { AGENT_DEVICE_DAEMON_BASE_URL: 'https://devices.example.com' }])).toContain('AGENT_DEVICE_DAEMON_BASE_URL');
    expect(mediaRefusal('android', 'device', undefined, [{}])).toBeUndefined();
  });

  it('is INVALID_ARGUMENT for a missing file, a directory, or no paths, before running anything', async () => {
    mkdirSync(path.join(dir, 'folder'));
    const { device, ran } = await setup({ platform: 'ios', kind: 'simulator', id: 'B7A6E3D8-94CA-41E2-A2A4-47BA79FDABA0' });
    await expect(device.addMedia('missing.jpg')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining(path.join(dir, 'missing.jpg')) });
    await expect(device.addMedia('folder')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(device.addMedia([])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(device.addMedia(['ok.jpg', ''])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(device.addMedia(42 as unknown as string)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(ran).toEqual([]);
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
      {},
      controller.signal,
    );
    await expect(device.addMedia('a.jpg')).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('kills a program that outlives the action timeout as OPERATION_TIMEOUT, and runs nothing after it', async () => {
    photo('a.jpg');
    photo('b.jpg');
    const { device, ran } = await setup(
      { platform: 'android', kind: 'emulator', id: 'emulator-5554' },
      (_command, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('killed'), { name: 'AbortError' })), { once: true });
        }),
      {},
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

  it("rejects with the program's stderr, and leaves out stderr too long to show instead of cutting it", async () => {
    expect(await stderrOf(failWith(12))).toBe('k'.repeat(12));
    // Half a secret no longer matches the redactor, so long output is dropped whole.
    expect(await stderrOf(failWith(5_000))).toBe('5000 characters of stderr, too long to show');
  });
});

describe('mediaCommands', () => {
  it('runs no program for an empty list on Android, and one simctl call on iOS', () => {
    expect(mediaCommands('android', 'emulator-5554', [], 'adb')).toEqual([]);
    expect(mediaCommands('ios', 'UDID', ['/a.jpg'], 'adb')).toEqual([{ file: 'xcrun', args: ['simctl', 'addmedia', 'UDID', '/a.jpg'] }]);
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
