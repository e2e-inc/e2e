/**
 * `e2e doctor` for a mobile target over a scripted client: agent-device's
 * doctor per configured device, mapped to e2e checks, and the build check.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineDoctorInfo } from '@e2e-dev/core/engine';
import { parsePlist, parsePlistDict } from '../../src/plist.ts';
import { harness, PROJECT_ROOT, type Harness, type HarnessOptions } from '../helpers/harness.ts';

const SIMULATOR_UDID = '0F5D8E2A-6B7C-4D3E-9A1B-2C3D4E5F6A7B';

const MACHINE = [
  { id: 'agent-device', status: 'pass', summary: 'agent-device 0.21.35' },
  { id: 'toolchain', status: 'pass', summary: 'Apple toolchain: Xcode 27.0.' },
  { id: 'session', status: 'info', summary: 'No active session.' },
  { id: 'metro', status: 'fail', summary: 'React Native dev server is not reachable.' },
];

/** A harness whose doctor answers per selected device: found when its name is in `known`. */
function doctorHarness(options: HarnessOptions, known: readonly string[] = []): Harness {
  const h = harness(options);
  // agent-device's inventory: one booted iPhone simulator, so the build check knows the target drives simulators.
  h.fake.respond('devices.list', () => [{ platform: 'ios', id: SIMULATOR_UDID, name: 'iPhone 17', kind: 'simulator', booted: true }]);
  h.fake.respond('command.doctor', (args) => {
    const { device, targetApp } = args as { device?: string; targetApp?: string };
    const found = device === undefined || known.includes(device);
    return {
      status: found ? 'pass' : 'fail',
      checks: [
        ...MACHINE,
        ...(found ? [{ id: 'ios-runner-cache', status: 'pass', summary: 'iOS runner artifact cached.' }] : []),
        found
          ? { id: 'device', status: 'pass', summary: '1 iOS device available; 1 booted.' }
          : { id: 'device', status: 'fail', summary: 'No iOS devices found.', hint: 'Start or create a simulator.' },
        ...(targetApp === undefined || !found ? [] : [device === undefined
          ? { id: 'target-app-device', status: 'fail', summary: 'Target app check needs one booted device; 4 matched.' }
          : { id: 'target-app', status: 'pass', summary: `Target app is launchable: ${targetApp}` }]),
      ],
    };
  });
  return h;
}

function info(h: Harness, projectRoot = PROJECT_ROOT): EngineDoctorInfo {
  return { targetName: 'ios-simulator', projectRoot, app: h.app, env: {}, headed: false, signal: new AbortController().signal, log: () => undefined };
}

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('doctor', () => {
  it('maps agent-device findings, dropping evidence, Metro, and an app check with no single booted device', async () => {
    const h = doctorHarness({});
    expect(await h.engine.doctor!(info(h))).toEqual([
      { id: 'agent-device', status: 'pass', message: 'agent-device 0.21.35' },
      { id: 'toolchain', status: 'pass', message: 'Apple toolchain: Xcode 27.0.' },
      { id: 'ios-runner-cache', status: 'pass', message: 'iOS runner artifact cached.' },
      { id: 'device', status: 'pass', message: '1 iOS device available; 1 booted.' },
    ]);
    expect(h.fake.lastArgs('command.doctor')).toMatchObject({ platform: 'ios', targetApp: 'Settings' });
    expect(h.sessions).toEqual(['e2e-ios-simulator-0']);
  });

  it('checks each configured device, machine checks once, and names the device it found missing', async () => {
    const h = doctorHarness({ device: ['Gone', 'iPhone 17'] }, ['iPhone 17']);
    expect(await h.engine.doctor!(info(h))).toEqual([
      { id: 'agent-device', status: 'pass', message: 'agent-device 0.21.35' },
      { id: 'toolchain', status: 'pass', message: 'Apple toolchain: Xcode 27.0.' },
      { id: 'device', status: 'fail', message: '"Gone": No iOS devices found. Start or create a simulator.' },
      { id: 'ios-runner-cache', status: 'pass', message: 'iOS runner artifact cached.' },
      { id: 'device', status: 'pass', message: '"iPhone 17": 1 iOS device available; 1 booted.' },
      { id: 'target-app', status: 'pass', message: '"iPhone 17": Target app is launchable: Settings' },
    ]);
  });

  it('selects a device by UDID', async () => {
    const udid = '78D5CEB4-D3A1-48E2-9AFD-6F8A99A824DA';
    const h = doctorHarness({ device: udid });
    await h.engine.doctor!(info(h));
    expect(h.fake.lastArgs('command.doctor')).toMatchObject({ platform: 'ios', udid });
  });

  it('checks the build appPath names instead of an installed app', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    writeFileSync(path.join(dir, 'App.app'), '');
    const present = doctorHarness({ appPath: 'App.app', bundleId: 'com.example.app' });
    const checks = await present.engine.doctor!(info(present, dir));
    expect(checks[0]).toEqual({ id: 'app-path', status: 'pass', message: path.join(dir, 'App.app') });
    expect(present.fake.lastArgs('command.doctor')).not.toHaveProperty('targetApp');

    const missing = doctorHarness({ appPath: 'Missing.app' });
    expect((await missing.engine.doctor!(info(missing, dir)))[0]).toMatchObject({ id: 'app-path', status: 'fail' });
  });

  it("skips the device and the build for a provider's leases without calling agent-device", async () => {
    const provider = { name: 'cloud', acquire: () => Promise.reject(new Error('unused')), release: () => Promise.resolve() };
    const h = doctorHarness({ device: provider, appPath: 'hosted.app' });
    expect(await h.engine.doctor!(info(h))).toEqual([{ id: 'device', status: 'skip', message: 'devices and the build come from the "cloud" provider' }]);
    expect(h.fake.methods()).toEqual([]);
  });

  it('passes an iOS simulator .app with matching XML Info.plist', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    const appDir = writeAppBundle(dir, 'Simulator.app', xmlPlist('com.example.app', ['iPhoneSimulator']));
    const h = doctorHarness({ appPath: 'Simulator.app', bundleId: 'com.example.app' });
    const checks = await h.engine.doctor!(info(h, dir));
    expect(checks[0]).toEqual({ id: 'app-path', status: 'pass', message: appDir });
  });

  it('passes an iOS simulator .app with matching binary bplist00 Info.plist', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    const appDir = writeAppBundle(dir, 'BinarySim.app', binaryPlistDict({
      CFBundleIdentifier: 'com.example.app',
      CFBundleSupportedPlatforms: ['iPhoneSimulator'],
    }));
    const h = doctorHarness({ appPath: 'BinarySim.app', bundleId: 'com.example.app' });
    const checks = await h.engine.doctor!(info(h, dir));
    expect(checks[0]).toEqual({ id: 'app-path', status: 'pass', message: appDir });
  });

  it('fails when an iOS .app is a device build (iPhoneOS) for a simulator target', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    const appDir = writeAppBundle(dir, 'Device.app', xmlPlist('com.example.app', ['iPhoneOS']));
    const h = doctorHarness({ appPath: 'Device.app', bundleId: 'com.example.app' });
    const checks = await h.engine.doctor!(info(h, dir));
    expect(checks[0]).toEqual({
      id: 'app-path',
      status: 'fail',
      message: `app.appPath ${appDir} is a device build (iPhoneOS); build for the simulator (-sdk iphonesimulator) or point app.appPath at a Debug-iphonesimulator build`,
    });
  });

  it('fails when a binary bplist00 .app is a device build (iPhoneOS)', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    const appDir = writeAppBundle(dir, 'BinaryDevice.app', binaryPlistDict({
      CFBundleIdentifier: 'com.example.app',
      CFBundleSupportedPlatforms: ['iPhoneOS'],
    }));
    const h = doctorHarness({ appPath: 'BinaryDevice.app', bundleId: 'com.example.app' });
    const checks = await h.engine.doctor!(info(h, dir));
    expect(checks[0]).toMatchObject({ id: 'app-path', status: 'fail', message: expect.stringContaining('is a device build (iPhoneOS)') });
    expect(checks[0]?.message).toContain(appDir);
  });

  it('fails when CFBundleIdentifier differs from app.bundleId, and passes when app.bundleId is unset', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    const appDir = writeAppBundle(dir, 'Mismatch.app', xmlPlist('com.example.other', ['iPhoneSimulator']));
    const mismatch = doctorHarness({ appPath: 'Mismatch.app', bundleId: 'com.example.app' });
    expect((await mismatch.engine.doctor!(info(mismatch, dir)))[0]).toEqual({
      id: 'app-path',
      status: 'fail',
      message: `app.appPath ${appDir} has CFBundleIdentifier com.example.other, but app.bundleId is com.example.app`,
    });

    const unpinned = doctorHarness({ appPath: 'Mismatch.app' });
    const unpinnedInfo: EngineDoctorInfo = { ...info(unpinned, dir), app: { appPath: 'Mismatch.app' } };
    expect((await unpinned.engine.doctor!(unpinnedInfo))[0]).toEqual({
      id: 'app-path',
      status: 'pass',
      message: appDir,
    });
  });

  it('skips the iPhoneSimulator platform check for physical iOS device targets', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    const appDir = writeAppBundle(dir, 'Phone.app', xmlPlist('com.example.app', ['iPhoneOS']));

    const byUdid = doctorHarness({ device: '00008110-001A2B3C4D5E6F70', appPath: 'Phone.app', bundleId: 'com.example.app' });
    byUdid.fake.respond('devices.list', () => [
      { platform: 'ios', id: '00008110-001A2B3C4D5E6F70', name: 'iPhone 15', kind: 'device', booted: true },
    ]);
    expect((await byUdid.engine.doctor!(info(byUdid, dir)))[0]).toEqual({
      id: 'app-path',
      status: 'pass',
      message: appDir,
    });

    const byInventory = doctorHarness({ device: 'iPhone 15', appPath: 'Phone.app', bundleId: 'com.example.app' });
    byInventory.fake.respond('devices.list', () => [
      { platform: 'ios', id: '00008110-001A2B3C4D5E6F70', name: 'iPhone 15', kind: 'device', booted: true },
    ]);
    expect((await byInventory.engine.doctor!(info(byInventory, dir)))[0]).toEqual({
      id: 'app-path',
      status: 'pass',
      message: appDir,
    });
  });

  it('handles missing or malformed Info.plist gracefully without crashing doctor', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    const missingDir = path.join(dir, 'NoPlist.app');
    mkdirSync(missingDir);
    const missing = doctorHarness({ appPath: 'NoPlist.app', bundleId: 'com.example.app' });
    expect((await missing.engine.doctor!(info(missing, dir)))[0]).toEqual({
      id: 'app-path',
      status: 'pass',
      message: missingDir,
    });

    const badXmlDir = writeAppBundle(dir, 'BadXml.app', '<plist><dict><key>CFBundleIdentifier</plist>');
    const badXml = doctorHarness({ appPath: 'BadXml.app', bundleId: 'com.example.app' });
    expect((await badXml.engine.doctor!(info(badXml, dir)))[0]).toEqual({
      id: 'app-path',
      status: 'pass',
      message: badXmlDir,
    });

    const badBinDir = writeAppBundle(dir, 'BadBin.app', Buffer.from('bplist00corrupt'));
    const badBin = doctorHarness({ appPath: 'BadBin.app', bundleId: 'com.example.app' });
    expect((await badBin.engine.doctor!(info(badBin, dir)))[0]).toEqual({
      id: 'app-path',
      status: 'pass',
      message: badBinDir,
    });
  });

  it('skips the simulator-platform check when devices.list fails (unknown target kind)', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    const appDir = writeAppBundle(dir, 'UnknownTarget.app', xmlPlist('com.example.app', ['iPhoneOS']));
    const h = doctorHarness({ device: 'iPhone 15', appPath: 'UnknownTarget.app', bundleId: 'com.example.app' });
    h.fake.respond('devices.list', () => {
      throw new Error('daemon unavailable');
    });
    expect((await h.engine.doctor!(info(h, dir)))[0]).toEqual({
      id: 'app-path',
      status: 'pass',
      message: appDir,
    });
  });

  it('counts a tvOS simulator build as a simulator build, and names the tvOS SDK for a tvOS device build', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    const tvSimulator = writeAppBundle(dir, 'TvSim.app', xmlPlist('com.example.tv', ['AppleTVSimulator']));
    const sim = doctorHarness({ appPath: 'TvSim.app', bundleId: 'com.example.tv' });
    expect((await sim.engine.doctor!(info(sim, dir)))[0]).toEqual({ id: 'app-path', status: 'pass', message: tvSimulator });

    const tvDevice = writeAppBundle(dir, 'TvDevice.app', xmlPlist('com.example.tv', ['AppleTVOS']));
    const device = doctorHarness({ appPath: 'TvDevice.app', bundleId: 'com.example.tv' });
    expect((await device.engine.doctor!(info(device, dir)))[0]).toEqual({
      id: 'app-path',
      status: 'fail',
      message: `app.appPath ${tvDevice} is a device build (AppleTVOS); build for the simulator (-sdk appletvsimulator) or point app.appPath at a Debug-appletvsimulator build`,
    });
  });

  it('trusts the build when the configured device is not in the inventory', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    const appDir = writeAppBundle(dir, 'Unlisted.app', xmlPlist('com.example.app', ['iPhoneOS']));
    const h = doctorHarness({ device: 'iPhone 99', appPath: 'Unlisted.app', bundleId: 'com.example.app' });
    expect((await h.engine.doctor!(info(h, dir)))[0]).toEqual({ id: 'app-path', status: 'pass', message: appDir });
  });

  it('stops when the doctor is cancelled while it reads the inventory', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    writeAppBundle(dir, 'Cancelled.app', xmlPlist('com.example.app', ['iPhoneOS']));
    const h = doctorHarness({ appPath: 'Cancelled.app', bundleId: 'com.example.app' });
    const controller = new AbortController();
    h.fake.respond('devices.list', () => {
      controller.abort();
      throw new Error('aborted');
    });
    const error = await h.engine.doctor!({ ...info(h, dir), signal: controller.signal }).then(() => undefined, (cause: unknown) => cause);
    // The cancel surfaces from the inventory read itself, not from a later command that found the signal aborted.
    expect(error).toMatchObject({ code: 'CANCELLED', message: expect.stringMatching(/^devices /) });
  });

  it('reads a binary Info.plist that plutil wrote, with UTF-16 strings and nested containers', () => {
    // tests/fixtures/plist/tvos-simulator-utf16.plist: `plutil -convert binary1` output, not this suite's encoder.
    const dict = parsePlistDict(readFileSync(path.join(import.meta.dirname, '../fixtures/plist/tvos-simulator-utf16.plist')));
    expect(dict).toMatchObject({
      CFBundleIdentifier: 'dev.e2e.café',
      CFBundleDisplayName: 'Café ✓ Résumé',
      CFBundleSupportedPlatforms: ['AppleTVSimulator'],
      CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconFiles: ['AppIcon60x60', ['nested']] } },
      MinimumOSVersion: '26.0',
    });
  });

  it('accepts app.bundleId matching CFBundleDisplayName or CFBundleName', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'e2e-mobile-doctor-'));
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.example.app</string>
  <key>CFBundleDisplayName</key>
  <string>HelloApp</string>
  <key>CFBundleName</key>
  <string>Hello</string>
  <key>CFBundleSupportedPlatforms</key>
  <array><string>iPhoneSimulator</string></array>
</dict>
</plist>`;
    const appDir = writeAppBundle(dir, 'Named.app', plist);

    const byDisplayName = doctorHarness({ appPath: 'Named.app', bundleId: 'HelloApp' });
    expect((await byDisplayName.engine.doctor!(info(byDisplayName, dir)))[0]).toEqual({
      id: 'app-path',
      status: 'pass',
      message: appDir,
    });

    const byBundleName = doctorHarness({ appPath: 'Named.app', bundleId: 'Hello' });
    expect((await byBundleName.engine.doctor!(info(byBundleName, dir)))[0]).toEqual({
      id: 'app-path',
      status: 'pass',
      message: appDir,
    });
  });

  it('decodes large UTF-16BE binary plist strings, ignores __proto__ pollution, and clamps out-of-range XML entities', () => {
    const longText = 'A'.repeat(200_000);
    const utf16Payload = Buffer.from(longText, 'utf16le').swap16();
    const lenBytes = Buffer.from([0x12, (longText.length >> 24) & 0xff, (longText.length >> 16) & 0xff, (longText.length >> 8) & 0xff, longText.length & 0xff]);
    const strObj = Buffer.concat([Buffer.from([0x6f]), lenBytes, utf16Payload]);
    const offsetTable = Buffer.alloc(4);
    offsetTable.writeUInt32BE(8, 0);
    const trailer = Buffer.alloc(32);
    trailer[6] = 4;
    trailer[7] = 1;
    trailer.writeBigUInt64BE(1n, 8);
    trailer.writeBigUInt64BE(0n, 16);
    trailer.writeBigUInt64BE(BigInt(8 + strObj.length), 24);
    const bplist = Buffer.concat([Buffer.from('bplist00', 'ascii'), strObj, offsetTable, trailer]);
    expect(parsePlist(bplist)).toBe(longText);

    const protoXml = Buffer.from('<plist version="1.0"><dict><key>__proto__</key><dict><key>polluted</key><true/></dict><key>ok</key><string>&#x110000;hi&#65;</string></dict></plist>');
    const parsed = parsePlist(protoXml) as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(parsed.ok).toBe('hiA');
  });
});

function writeAppBundle(root: string, name: string, plistContent: string | Buffer): string {
  const appDir = path.join(root, name);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(path.join(appDir, 'Info.plist'), plistContent);
  return appDir;
}

function xmlPlist(bundleId: string, platforms: readonly string[]): string {
  const items = platforms.map((platform) => `<string>${platform}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleSupportedPlatforms</key>
  <array>${items}</array>
</dict>
</plist>`;
}

/** Encodes a small string/string-array dictionary as a valid `bplist00` binary plist. */
function binaryPlistDict(entries: Readonly<Record<string, string | readonly string[]>>): Buffer {
  const objects: Buffer[] = [];
  const offsets: number[] = [];

  const addObject = (buf: Buffer): number => {
    const index = objects.length;
    objects.push(buf);
    return index;
  };

  const addString = (value: string): number => {
    const raw = Buffer.from(value, 'ascii');
    if (raw.length < 0x0f) {
      return addObject(Buffer.concat([Buffer.from([0x50 | raw.length]), raw]));
    }
    const lenBuf = raw.length <= 0xff
      ? Buffer.from([0x10, raw.length])
      : Buffer.from([0x11, (raw.length >> 8) & 0xff, raw.length & 0xff]);
    return addObject(Buffer.concat([Buffer.from([0x5f]), lenBuf, raw]));
  };

  const keys = Object.keys(entries);
  const keyRefs = keys.map(addString);
  const valRefs = keys.map((key) => {
    const value = entries[key]!;
    if (typeof value === 'string') return addString(value);
    const itemRefs = value.map(addString);
    return addObject(Buffer.from([0xa0 | itemRefs.length, ...itemRefs]));
  });

  const topObject = addObject(Buffer.from([0xd0 | keys.length, ...keyRefs, ...valRefs]));

  let cursor = 8;
  for (const obj of objects) {
    offsets.push(cursor);
    cursor += obj.length;
  }

  const offsetTableOffset = cursor;
  const offsetIntSize = offsetTableOffset <= 0xff ? 1 : 2;
  const offsetTable = Buffer.alloc(offsets.length * offsetIntSize);
  offsets.forEach((off, i) => {
    if (offsetIntSize === 1) offsetTable.writeUInt8(off, i);
    else offsetTable.writeUInt16BE(off, i * 2);
  });

  const trailer = Buffer.alloc(32);
  trailer[6] = offsetIntSize;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(topObject), 16);
  trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24);

  return Buffer.concat([Buffer.from('bplist00', 'ascii'), ...objects, offsetTable, trailer]);
}
