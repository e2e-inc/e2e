/**
 * Puts the builds of a native addon a release made into its platform
 * packages (`packages/desktop/npm/darwin-*` for the desktop driver, `packages/util/npm/*` for `@e2e-dev/util`), each
 * stamped with its package's version, so their `prepublishOnly`
 * (`check-native.ts`) passes. Run after the version step, right before
 * publishing.
 *
 * Usage: `node scripts/native/place-native.ts <addon> <directory with the addon's .node files>`. A file may also sit
 * one directory down, the way `gh run download` leaves each artifact of a run in a directory of its own. With
 * `--dry-run` it only checks every build is there, so `pnpm run canary` stops before it versions and builds.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findAddon, addonFile, platformPackageDir, replaceAddon, scriptArgs } from './addons.ts';

const { values, positionals } = parseArgs({ args: scriptArgs(), allowPositionals: true, options: { 'dry-run': { type: 'boolean' } } });
const [name, source] = positionals;
const addon = findAddon(name);
if (source === undefined || source === '' || !existsSync(source)) throw new Error(`usage: place-native.ts ${addon.name} <directory with ${addon.file}.*.node>${source ? `; ${source} does not exist` : ''}`);
for (const platform of Object.values(addon.targets)) {
  const fileName = addonFile(addon, platform);
  const subdirectories = readdirSync(source, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const file = [path.join(source, fileName), ...subdirectories.map((entry) => path.join(source, entry.name, fileName))].find((candidate) => existsSync(candidate));
  if (file === undefined) throw new Error(`${path.join(source, fileName)} is missing: the native build did not make it`);
  if (values['dry-run'] === true) continue;
  const target = platformPackageDir(addon, platform);
  // Given the platform packages' own directory, the file is already in place, and replacing it would delete it.
  if (path.resolve(file) !== path.resolve(target, fileName)) replaceAddon(file, path.join(target, fileName));
  const { version } = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8')) as { version: string };
  writeFileSync(path.join(target, '.build.json'), `${JSON.stringify({ version })}\n`);
  process.stdout.write(`placed ${file} in ${target} for ${version}\n`);
}
