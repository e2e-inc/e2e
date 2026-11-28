/**
 * Fails when a public package's peer on another public package (an engine's
 * on `e2e`, an integration's on an engine) is anything but
 * `>=<major.minor.patch> <major+1>`.
 *
 * `changeset version --snapshot canary` rewrites those peers to the siblings'
 * exact canary versions, and the canary output is committed to main as
 * `chore: release`. An exact pin that lands makes changesets patch-bump the
 * dependent and rewrite the pin on each release of the sibling, and leaves a
 * consumer who updates the sibling alone with a peer npm 7+ refuses
 * (ERESOLVE). `restore-peer-ranges.ts` puts the ranges back after a publish;
 * this check is what notices when it did not run.
 *
 * It also holds every package that drives agent-device to the engine's pin
 * (`agent-device-pins.ts`): the version check between them runs only once a
 * device is leased, so a pin a bump missed would install and then fail.
 *
 * Usage: `node scripts/check-peer-ranges.ts`, part of `pnpm check`. Exits 1
 * listing every offending peer.
 */

import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import { agentDevicePins, compareVersions, type EngineReleases } from './agent-device-pins.ts';
import { REPO_ROOT, isWidePeerRange, publicPackages, siblingPeers } from './public-packages.ts';

const packages = publicPackages();
const siblings = new Set(packages.map(({ manifest }) => manifest.name));
const problems: string[] = [];
const checked: string[] = [];
for (const { path, manifest } of packages) {
  for (const [peer, range] of siblingPeers(manifest.peerDependencies, siblings)) {
    checked.push(`${manifest.name} on ${peer} (${range})`);
    if (!isWidePeerRange(range)) {
      problems.push(
        `${relative(REPO_ROOT, path)}: ${peer} peer is ${JSON.stringify(range)}, expected >=<major.minor.patch> <major+1>; run \`node scripts/restore-peer-ranges.ts\``,
      );
    }
  }
}

/** Runs git in the repository; undefined when it fails (no git, a path the tag does not have). */
function git(...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

/** The engine's releases from its `@e2e-dev/mobile@<version>` tags; undefined in a checkout without them. */
function engineReleases(): EngineReleases | undefined {
  const prefix = '@e2e-dev/mobile@';
  const listed = git('tag', '--list', `${prefix}*`);
  // A git that cannot run is not a checkout without tags: the floors would go unchecked with only a note.
  if (listed === undefined) throw new Error(`check-peer-ranges: git could not list the ${prefix} tags, so the agent-device floors cannot be checked`);
  const versions = listed.split('\n').map((tag) => tag.trim()).filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length));
  if (versions.length === 0) return undefined;
  const pins = new Map<string, string | undefined>();
  const pinOf = (version: string): string | undefined => {
    if (!pins.has(version)) {
      const manifest = git('show', `${prefix}${version}:packages/mobile/package.json`);
      pins.set(version, manifest === undefined ? undefined : (JSON.parse(manifest) as { dependencies?: Record<string, string> }).dependencies?.['agent-device']);
    }
    return pins.get(version);
  };
  const tagged = new Set(versions);
  return {
    release: (version) => (tagged.has(version) ? { tagged: true, agentDevice: pinOf(version) } : { tagged: false }),
    releasedWith: (pin) => versions.filter((version) => !version.includes('-') && pinOf(version) === pin).toSorted(compareVersions),
  };
}

const pins = agentDevicePins(packages.map(({ manifest }) => manifest), engineReleases());
problems.push(...pins.problems);
for (const note of pins.notes) process.stderr.write(`${note}\n`);

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`peer ranges: ${checked.toSorted().join(', ')} as wide ranges\n`);
  process.stdout.write(`agent-device: ${pins.pinned.join(', ')} on ${String(pins.version)}\n`);
}
