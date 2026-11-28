/**
 * The checks of `e2e doctor` for a mobile target: agent-device's own doctor
 * (its install, the platform toolchain, the device, the app) for each device
 * the target names, and the build `appPath` points at.
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { obj, type EngineDoctorCheck, type EngineDoctorInfo } from '@e2e-dev/core/engine';
import { runCommand } from './errors.ts';
import type { AgentDeviceClient, ClientFactory, MobileOptions } from './options.ts';
import { deviceSelection } from './bindings.ts';
import { parsePlistDict } from './plist.ts';
import { isDeviceList } from './pool.ts';
import type { DeviceProvider } from './provider.ts';

/** Checks that apply to the whole machine, reported once however many devices the target names. */
const MACHINE_CHECKS = new Set(['agent-device', 'toolchain', 'ios-runner-cache']);

/**
 * Checks e2e drops: `metro` because only the app knows whether it loads its
 * bundle from a dev server, `target-app-device` because it only says the app
 * check had no single booted device to run on, which a run boots.
 */
const DROPPED_CHECKS = new Set(['metro', 'target-app-device']);

const CHECK_ID = /^[a-z][a-z0-9-]*$/;

/**
 * Runs agent-device's doctor once per device the target names (once with no
 * device, for the booted one a run picks) and checks the build `appPath`
 * names. A provider's devices are not on this machine, and the provider
 * reads `appPath` its own way, so neither is checked for one.
 */
export async function mobileDoctor(options: MobileOptions, createClient: ClientFactory, session: string, info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]> {
  const { device } = options;
  const devices = device === undefined ? [undefined] : typeof device === 'string' ? [device] : isDeviceList(device) ? device : undefined;
  if (devices === undefined) return [{ id: 'device', status: 'skip', message: `devices and the build come from the "${(device as DeviceProvider).name}" provider` }];
  const targetApp = info.app.appPath === undefined ? info.app.bundleId : undefined;
  const client = createClient(session);
  const build = await buildCheck(options, devices, client, info);
  const checks: EngineDoctorCheck[] = [...build];
  const reported = new Set<string>();
  for (const name of devices) {
    info.log(`agent-device doctor${name === undefined ? '' : ` for "${name}"`}`);
    const result = await runCommand(
      'doctor',
      () => client.command.doctor(obj({ ...deviceSelection(options.platform, name === undefined ? undefined : { device: name }), targetApp, signal: info.signal })),
      info.signal,
    );
    for (const check of result.checks) {
      if (DROPPED_CHECKS.has(check.id) || !CHECK_ID.test(check.id)) continue;
      const status = statusOf(check.status);
      if (status === undefined) continue;
      if (MACHINE_CHECKS.has(check.id)) {
        if (reported.has(check.id)) continue;
        reported.add(check.id);
      }
      const found = status === 'pass' || check.hint === undefined ? check.summary : `${check.summary} ${check.hint}`;
      checks.push({ id: check.id, status, message: name === undefined || MACHINE_CHECKS.has(check.id) ? found : `"${name}": ${found}` });
    }
  }
  return checks;
}

/** agent-device's status as an e2e one; `info` is evidence, not a finding, so it reports nothing. */
function statusOf(status: string): EngineDoctorCheck['status'] | undefined {
  return status === 'pass' || status === 'warn' || status === 'fail' ? status : undefined;
}

/** Physical iOS device UDIDs (8-16 ECID or 40-char legacy SHA1). */
const PHYSICAL_IOS_UDID = /^(?:[0-9A-F]{8}-[0-9A-F]{16}|[0-9A-F]{40})$/i;
/** Simulator UDIDs (8-4-4-4-12 UUID). */
const SIMULATOR_IOS_UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

type IosTargetKind = 'simulator' | 'device' | 'unknown';

/**
 * Classifies whether the target selects simulators, physical iOS devices, or
 * cannot be determined (for example when `devices.list` fails).
 */
async function classifyIosTarget(
  devices: readonly (string | undefined)[],
  client: AgentDeviceClient,
  signal: AbortSignal,
): Promise<IosTargetKind> {
  const configured = devices.filter((name): name is string => name !== undefined);
  if (configured.length > 0) {
    if (configured.every((name) => PHYSICAL_IOS_UDID.test(name))) return 'device';
    if (configured.every((name) => SIMULATOR_IOS_UDID.test(name))) return 'simulator';
  }
  try {
    const inventory: unknown = await runCommand('devices', () => client.devices.list({ platform: 'ios' }), signal);
    if (!Array.isArray(inventory)) return 'simulator';
    const entries = inventory.filter(
      (entry): entry is { id?: unknown; name?: unknown; kind?: unknown; platform?: unknown; booted?: unknown } =>
        typeof entry === 'object' && entry !== null,
    );
    if (configured.length > 0) {
      const matched = configured
        .map((target) => entries.find((entry) => entry.id === target || entry.name === target))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
      return matched.length === configured.length && matched.every((entry) => entry.kind === 'device')
        ? 'device'
        : 'simulator';
    }
    const booted = entries.filter((entry) => entry.platform === 'ios' && entry.booted === true);
    return booted.length > 0 && booted.every((entry) => entry.kind === 'device') ? 'device' : 'simulator';
  } catch {
    return 'unknown';
  }
}

/**
 * Whether the build `appPath` names is on disk, and for an iOS `.app` bundle
 * whether its `Info.plist` is a simulator build matching `app.bundleId`.
 */
async function buildCheck(
  options: MobileOptions,
  devices: readonly (string | undefined)[],
  client: AgentDeviceClient,
  info: EngineDoctorInfo,
): Promise<readonly EngineDoctorCheck[]> {
  const { appPath } = info.app;
  if (appPath === undefined) return [];
  const resolved = path.resolve(info.projectRoot, appPath);
  try {
    await stat(resolved);
  } catch {
    return [{ id: 'app-path', status: 'fail', message: `app.appPath ${resolved} does not exist; build the app or fix the path` }];
  }
  if (options.platform !== 'ios' || !resolved.endsWith('.app')) {
    return [{ id: 'app-path', status: 'pass', message: resolved }];
  }

  let plistBytes: Buffer;
  try {
    plistBytes = await readFile(path.join(resolved, 'Info.plist'));
  } catch {
    return [{ id: 'app-path', status: 'pass', message: resolved }];
  }
  const plist = parsePlistDict(plistBytes);
  if (plist === undefined) return [{ id: 'app-path', status: 'pass', message: resolved }];

  const rawPlatforms = plist.CFBundleSupportedPlatforms;
  const platforms = Array.isArray(rawPlatforms) ? rawPlatforms.filter((entry): entry is string => typeof entry === 'string') : undefined;
  if (platforms !== undefined && !platforms.includes('iPhoneSimulator')) {
    const targetKind = await classifyIosTarget(devices, client, info.signal);
    if (targetKind === 'simulator') {
      const detail = platforms.length > 0
        ? `is a device build (${platforms.join(', ')})`
        : 'is not a simulator build (CFBundleSupportedPlatforms does not include iPhoneSimulator)';
      return [{
        id: 'app-path',
        status: 'fail',
        message: `app.appPath ${resolved} ${detail}; build for the simulator (-sdk iphonesimulator) or point app.appPath at a Debug-iphonesimulator build`,
      }];
    }
  }

  const bundleId = typeof plist.CFBundleIdentifier === 'string' && plist.CFBundleIdentifier.length > 0
    ? plist.CFBundleIdentifier
    : undefined;
  const displayName = typeof plist.CFBundleDisplayName === 'string' && plist.CFBundleDisplayName.length > 0
    ? plist.CFBundleDisplayName
    : undefined;
  const bundleName = typeof plist.CFBundleName === 'string' && plist.CFBundleName.length > 0
    ? plist.CFBundleName
    : undefined;
  const appIdentifiers = [bundleId, displayName, bundleName].filter((id): id is string => id !== undefined);
  if (info.app.bundleId !== undefined && appIdentifiers.length > 0 && !appIdentifiers.includes(info.app.bundleId)) {
    const reported = bundleId !== undefined ? `CFBundleIdentifier ${bundleId}` : `bundle name ${displayName ?? bundleName}`;
    return [{
      id: 'app-path',
      status: 'fail',
      message: `app.appPath ${resolved} has ${reported}, but app.bundleId is ${info.app.bundleId}`,
    }];
  }

  return [{ id: 'app-path', status: 'pass', message: resolved }];
}
