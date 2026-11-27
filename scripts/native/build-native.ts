/**
 * Builds a NAPI addon (`addons.ts`) for this machine, or for the target
 * triple given, and puts it where its package's loader takes it from in a
 * checkout: `packages/<package>/<file>.<platform>.node`.
 *
 * Usage: `node scripts/native/build-native.ts <addon> [--target x86_64-apple-darwin] [--out <dir>]`,
 * or `pnpm --filter @e2e-dev/desktop build:native` for the desktop driver.
 * `--out` copies the addon into another directory too, the platform package
 * (`packages/desktop/npm/darwin-*`) before it is published, with a stamp naming
 * that package's version, which its `prepublishOnly` checks. Needs a Rust
 * toolchain (`rustup`). A macOS target builds on macOS only.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findAddon, addonFile, replaceAddon, ROOT, scriptArgs } from './addons.ts';
import { cargo } from './cargo.ts';

/** The oldest macOS an addon runs on. */
const DEPLOYMENT_TARGET = '13.0';

const { values, positionals } = parseArgs({ args: scriptArgs(), allowPositionals: true, options: { target: { type: 'string' }, out: { type: 'string' } } });
const addon = findAddon(positionals[0]);
const host = `${process.platform}-${process.arch}`;
const target = values.target ?? Object.keys(addon.targets).find((triple) => addon.targets[triple] === host);
if (target === undefined) throw new Error(`no ${addon.name} addon build for ${host}; name a target, one of ${Object.keys(addon.targets).join(', ')}`);
const platform = Object.hasOwn(addon.targets, target) ? addon.targets[target] : undefined;
if (platform === undefined) throw new Error(`no ${addon.name} addon build for ${target}; one of ${Object.keys(addon.targets).join(', ')}`);
if (target.endsWith('-apple-darwin') && process.platform !== 'darwin') throw new Error(`${target} builds on macOS only`);

const crate = addon.crateDir;
const run = cargo(crate);
const name = addonFile(addon, platform);
// Paths the binary would otherwise carry (panic locations, a dylib's install name) name the machine and the user that
// built it, and make two builds of one commit differ: they are mapped to fixed names.
const cargoHome = process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo');
const rustflags = [
  process.env.RUSTFLAGS,
  `--remap-path-prefix=${ROOT}=e2e`,
  `--remap-path-prefix=${cargoHome}=cargo`,
  ...(target.includes('-apple-') ? [`-Clink-arg=-Wl,-install_name,@rpath/${name}`] : []),
]
  .filter(Boolean)
  .join(' ');
const env = { ...run.env, MACOSX_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET, RUSTFLAGS: rustflags };
// A pinned toolchain installed before (another checkout's, or under a `RUSTUP_TOOLCHAIN` override) may lack this
// target's standard library; adding one already there is a no-op.
if (run.toolchain !== undefined) execFileSync('rustup', ['target', 'add', '--toolchain', run.toolchain, target], { cwd: crate, stdio: 'inherit', env });
execFileSync(run.file, [...run.prefix, 'build', '--release', '--locked', '--target', target], { cwd: crate, stdio: 'inherit', env });
// Where cargo wrote it: `CARGO_TARGET_DIR` or a cargo config can move the target directory off the workspace's `target`.
const metadata = JSON.parse(execFileSync(run.file, [...run.prefix, 'metadata', '--format-version', '1', '--no-deps'], { cwd: crate, encoding: 'utf8', env })) as { target_directory: string };
const built = path.join(metadata.target_directory, target, 'release', library(addon.crate, target));
replaceAddon(built, path.join(addon.packageDir, name));
if (values.out !== undefined) {
  // Relative to where the command was typed: `pnpm --filter` runs the script in the package, and sets INIT_CWD to that directory.
  const out = path.resolve(process.env.INIT_CWD ?? process.cwd(), values.out);
  const manifest = path.join(out, 'package.json');
  const platformPackage = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, 'utf8')) as { name: string; version: string; main?: string }) : undefined;
  // A platform package takes only the addon its `main` names: one for another platform would be stamped and published as its.
  if (platformPackage?.main !== undefined && platformPackage.main !== name) {
    throw new Error(`${platformPackage.name} ships ${platformPackage.main}, not ${name}; build it with the --target its cpu names`);
  }
  mkdirSync(out, { recursive: true });
  replaceAddon(built, path.join(out, name));
  if (platformPackage !== undefined) writeFileSync(path.join(out, '.build.json'), `${JSON.stringify({ version: platformPackage.version })}\n`);
  process.stdout.write(`built ${path.join(out, name)}\n`);
}
process.stdout.write(`built ${path.join(addon.packageDir, name)}\n`);

/** The file name cargo gives a crate's `cdylib` on a target. */
function library(crateName: string, triple: string): string {
  const base = crateName.replaceAll('-', '_');
  if (triple.includes('-apple-')) return `lib${base}.dylib`;
  if (triple.includes('-windows-')) return `${base}.dll`;
  return `lib${base}.so`;
}
