/**
 * The agent-device version every package that drives a device through it
 * must pin. `@e2e-dev/mobile` pins `agent-device` exactly, and a provider
 * that starts its own daemon (`agent-device`) or loads a device-cloud plugin
 * (`@agent-device/<cloud>`) checks at the first lease that its copy is the
 * engine's (`agentDevicePlugin().assertVersion`). npm cannot see that check,
 * so a pin one package missed in a bump installs cleanly and fails the run.
 *
 * The provider's peer floor on the engine is what keeps a user's install in
 * step, so it must name an engine release that ships the same pin: a tagged
 * `@e2e-dev/mobile@<floor>` whose manifest pins it, or, with no such tag, the
 * release still to come, above the engine's current version.
 */

import { wideRangeFloor, type PackageManifest } from './public-packages.ts';

const ENGINE = '@e2e-dev/mobile';

/** What the engine's release history says about one version: the agent-device it pinned, or that no release of it is tagged. */
export type EngineRelease = { readonly tagged: true; readonly agentDevice: string | undefined } | { readonly tagged: false };

/** The engine's releases, read from its git tags; `undefined` when the checkout has none of them. */
export interface EngineReleases {
  release(version: string): EngineRelease;
  /** The versions released with `pin`, oldest first. */
  releasedWith(pin: string): readonly string[];
}

/** Whether `name` is agent-device or one of its device-cloud plugins. */
function isAgentDevicePackage(name: string): boolean {
  return name === 'agent-device' || name.startsWith('@agent-device/');
}

/** Compares two `major.minor.patch` versions, ignoring any prerelease. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split(/[.-]/).slice(0, 3).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index += 1) {
    const diff = (x[index] ?? 0) - (y[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The next patch release after `version`. */
function nextPatch(version: string): string {
  const [major, minor, patch] = version.split(/[.-]/).slice(0, 3).map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

/** What `agentDevicePins` found: the pin, the packages on it, every disagreement as one line, and notes that do not fail the check. */
export interface AgentDevicePins {
  readonly version: string | undefined;
  readonly pinned: readonly string[];
  readonly problems: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Checks that every package depending on agent-device or a plugin of it pins
 * the version `@e2e-dev/mobile` pins, exactly, and that every such package
 * other than the engine peers on the engine with a floor that ships that pin.
 * Without `releases` (a checkout with no engine tags), the floors are not
 * checked and a note says so.
 */
export function agentDevicePins(manifests: readonly PackageManifest[], releases: EngineReleases | undefined): AgentDevicePins {
  const engine = manifests.find((manifest) => manifest.name === ENGINE);
  const version = engine?.dependencies?.['agent-device'];
  if (engine === undefined || version === undefined) {
    return { version: undefined, pinned: [], problems: [`${ENGINE} does not depend on agent-device, so no pin can be checked`], notes: [] };
  }
  const current = engine.version ?? '0.0.0';
  const shipped = releases?.releasedWith(version)[0];
  const expected = shipped ?? nextPatch(current);
  const problems: string[] = [];
  const notes: string[] = [];
  const pinned: string[] = [];
  for (const manifest of manifests) {
    // npm installs an optional dependency over a same-named regular one, so it is the one held to the pin.
    const drivers = Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies }).filter(([name]) => isAgentDevicePackage(name));
    if (drivers.length === 0) continue;
    pinned.push(manifest.name);
    const offPin = drivers.filter(([, range]) => range !== version);
    for (const [name, range] of offPin) {
      problems.push(`${manifest.name} depends on ${name} ${JSON.stringify(range)}; ${ENGINE} pins agent-device ${JSON.stringify(version)}`);
    }
    if (manifest.name === ENGINE) continue;
    const range = manifest.peerDependencies?.[ENGINE];
    if (range === undefined) {
      problems.push(`${manifest.name} drives agent-device but has no ${ENGINE} peer, so nothing keeps the engine it runs beside on the same agent-device`);
      continue;
    }
    // A package off the pin is reported above; its floor belongs to another pin.
    if (offPin.length > 0 || releases === undefined) continue;
    const floor = wideRangeFloor(range);
    if (floor === undefined) continue;
    const release = releases.release(floor);
    const fix = `raise it to >=${expected}, the first ${ENGINE} release on agent-device ${version}`;
    if (release.tagged && release.agentDevice !== version) {
      problems.push(`${manifest.name} peers on ${ENGINE} ${JSON.stringify(range)}, but ${ENGINE} ${floor} pins agent-device ${JSON.stringify(release.agentDevice)}, not ${JSON.stringify(version)}: ${fix}`);
    } else if (!release.tagged && compareVersions(floor, current) <= 0) {
      problems.push(`${manifest.name} peers on ${ENGINE} ${JSON.stringify(range)}, but no ${ENGINE} ${floor} release is tagged, and ${current} is the engine's current version: ${fix}`);
    }
  }
  if (releases === undefined) notes.push(`${ENGINE} floors not checked: this checkout has no ${ENGINE}@ tags (git fetch --tags)`);
  return { version, pinned: pinned.toSorted(), problems, notes };
}
