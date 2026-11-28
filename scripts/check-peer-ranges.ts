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

import { relative } from 'node:path';
import { agentDevicePins } from './agent-device-pins.ts';
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

const pins = agentDevicePins(packages.map(({ manifest }) => manifest));
problems.push(...pins.problems);

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`peer ranges: ${checked.toSorted().join(', ')} as wide ranges\n`);
  process.stdout.write(`agent-device: ${pins.pinned.join(', ')} on ${String(pins.version)}\n`);
}
