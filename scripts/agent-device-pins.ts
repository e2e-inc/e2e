/**
 * The agent-device version every package that drives a device through it
 * must pin. `@e2e-dev/mobile` pins `agent-device` exactly, and a provider
 * that starts its own daemon (`agent-device`) or loads a device-cloud plugin
 * (`@agent-device/<cloud>`) checks at the first lease that its copy is the
 * engine's (`agentDevicePlugin().assertVersion`). npm cannot see that check,
 * so a pin one package missed in a bump installs cleanly and fails the run.
 * The peer floor on the engine is what keeps a user's install in step: every
 * such package needs the engine release that ships the same pin, so their
 * floors move together.
 */

import type { PackageManifest } from './public-packages.ts';

const ENGINE = '@e2e-dev/mobile';

/** Whether `name` is agent-device or one of its device-cloud plugins. */
function isAgentDevicePackage(name: string): boolean {
  return name === 'agent-device' || name.startsWith('@agent-device/');
}

/** The lowest version a `>=x.y.z <n` range admits, or undefined for any other shape. */
function floorOf(range: string): [number, number, number] | undefined {
  const match = /^>=(\d+)\.(\d+)\.(\d+) <\d+$/.exec(range);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** What `agentDevicePins` found: the pin, the packages on it, and every disagreement as one line. */
export interface AgentDevicePins {
  readonly version: string | undefined;
  readonly pinned: readonly string[];
  readonly problems: readonly string[];
}

/**
 * Checks that every package depending on agent-device or a plugin of it pins
 * the version `@e2e-dev/mobile` pins, exactly, and that every such package
 * other than the engine peers on the engine with the same floor.
 */
export function agentDevicePins(manifests: readonly PackageManifest[]): AgentDevicePins {
  const engine = manifests.find((manifest) => manifest.name === ENGINE);
  const version = engine?.dependencies?.['agent-device'];
  if (engine === undefined || version === undefined) {
    return { version: undefined, pinned: [], problems: [`${ENGINE} does not depend on agent-device, so no pin can be checked`] };
  }
  const problems: string[] = [];
  const pinned: string[] = [];
  const floors: { name: string; range: string; floor: [number, number, number] }[] = [];
  for (const manifest of manifests) {
    const drivers = Object.entries(manifest.dependencies ?? {}).filter(([name]) => isAgentDevicePackage(name));
    if (drivers.length === 0) continue;
    pinned.push(manifest.name);
    for (const [name, range] of drivers) {
      if (range !== version) problems.push(`${manifest.name} depends on ${name} ${JSON.stringify(range)}; ${ENGINE} pins agent-device ${JSON.stringify(version)}`);
    }
    if (manifest.name === ENGINE) continue;
    const range = manifest.peerDependencies?.[ENGINE];
    if (range === undefined) {
      problems.push(`${manifest.name} drives agent-device but has no ${ENGINE} peer, so nothing keeps the engine it runs beside on the same agent-device`);
      continue;
    }
    const floor = floorOf(range);
    if (floor !== undefined) floors.push({ name: manifest.name, range, floor });
  }
  const highest = floors.reduce<(typeof floors)[number] | undefined>((top, entry) => (top === undefined || compare(entry.floor, top.floor) > 0 ? entry : top), undefined);
  if (highest !== undefined) {
    for (const entry of floors) {
      if (compare(entry.floor, highest.floor) < 0) {
        problems.push(`${entry.name} peers on ${ENGINE} ${JSON.stringify(entry.range)}, below ${highest.name}'s ${JSON.stringify(highest.range)}: every package on agent-device ${version} needs the engine release that ships it`);
      }
    }
  }
  return { version, pinned: pinned.toSorted(), problems };
}
