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
 *
 * Every build also writes the addon's TypeScript types (`types` in
 * `addons.ts`) from the crate's `#[napi]` items, the way `napi build --dts`
 * does. The file is committed, and CI fails when a build changes it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { generateTypeDef } from '@napi-rs/cli';
import { findAddon, addonFile, replaceAddon, scriptArgs } from './addons.ts';
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
// napi-derive writes what each `#[napi]` item looks like from TypeScript into this folder while the crate compiles.
// Cargo would skip a crate it has already built, and leave the folder empty: `napi-build` reruns the crate's build
// script when the second variable changes, which compiles the crate again.
const typeDefs = mkdtempSync(path.join(tmpdir(), `${addon.crate}-types-`));
const env = { ...run.env, MACOSX_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET, NAPI_TYPE_DEF_TMP_FOLDER: typeDefs, [`NAPI_FORCE_BUILD_${addon.crate.replaceAll('-', '_').toUpperCase()}`]: String(Date.now()) };
// A pinned toolchain installed before (another checkout's, or under a `RUSTUP_TOOLCHAIN` override) may lack this
// target's standard library; adding one already there is a no-op.
if (run.toolchain !== undefined) execFileSync('rustup', ['target', 'add', '--toolchain', run.toolchain, target], { cwd: crate, stdio: 'inherit', env });
execFileSync(run.file, [...run.prefix, 'build', '--release', '--locked', '--target', target], { cwd: crate, stdio: 'inherit', env });
// Where cargo wrote it: `CARGO_TARGET_DIR` or a cargo config can move the target directory off the workspace's `target`.
const metadata = JSON.parse(execFileSync(run.file, [...run.prefix, 'metadata', '--format-version', '1', '--no-deps'], { cwd: crate, encoding: 'utf8', env })) as { target_directory: string };
const built = path.join(metadata.target_directory, target, 'release', library(addon.crate, target));
const header = [`// Written by \`node scripts/native/build-native.ts ${addon.name}\` from crates/${addon.crate}. Do not edit.`, ...addon.typeImports, '', ''].join('\n');
const { dts } = await generateTypeDef({ typeDefDir: typeDefs, cwd: crate, dtsHeader: header });
rmSync(typeDefs, { recursive: true, force: true });
if (dts.trim() === header.trim()) throw new Error(`the build of ${addon.crate} wrote no types`);
writeFileSync(path.join(addon.packageDir, addon.types), dts);
const name = addonFile(addon, platform);
replaceAddon(built, path.join(addon.packageDir, name));
if (values.out !== undefined) {
  mkdirSync(values.out, { recursive: true });
  replaceAddon(built, path.join(values.out, name));
  const manifest = path.join(values.out, 'package.json');
  if (existsSync(manifest)) {
    const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
    writeFileSync(path.join(values.out, '.build.json'), `${JSON.stringify({ version })}\n`);
  }
}
process.stdout.write(`built ${path.join(addon.packageDir, name)}\n`);

/** The file name cargo gives a crate's `cdylib` on a target. */
function library(crateName: string, triple: string): string {
  const base = crateName.replaceAll('-', '_');
  if (triple.includes('-apple-')) return `lib${base}.dylib`;
  if (triple.includes('-windows-')) return `${base}.dll`;
  return `lib${base}.so`;
}
