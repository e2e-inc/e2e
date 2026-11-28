/**
 * Checks a native addon build before it ships, on whichever machine built it:
 * the file is a shared library for the target's OS and architecture (only an
 * arm64 Mac, say, can load an arm64 build, so a load on the build machine
 * proves nothing about a cross build), a Linux build links the C library its
 * target names, and a glibc build asks for no symbol version newer than
 * `GLIBC_FLOOR`, the glibc the release builds on.
 *
 * Usage: `node scripts/native/check-build.ts <addon> <target triple>`, after
 * `build-native.ts` placed `packages/<package>/<file>.<platform>.node`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { addonFile, findAddon, scriptArgs } from './addons.ts';

/** The newest glibc a `-gnu` build may need: Ubuntu 22.04's, which builds them, so 22.04 and later load them. */
const GLIBC_FLOOR: readonly [number, number] = [2, 35];

const [name, target] = scriptArgs();
const addon = findAddon(name);
const platform = target !== undefined && Object.hasOwn(addon.targets, target) ? addon.targets[target] : undefined;
if (target === undefined || platform === undefined) throw new Error(`name a target of ${addon.name}: one of ${Object.keys(addon.targets).join(', ')}`);
const file = path.join(addon.packageDir, addonFile(addon, platform));
const bytes = readFileSync(file);
if (!target.startsWith('aarch64-') && !target.startsWith('x86_64-')) throw new Error(`no architecture check for ${target}`);
const arm64 = target.startsWith('aarch64-');

const found = format(bytes);
const expected = target.includes('-apple-') ? 'mach-o' : target.includes('-windows-') ? 'pe' : 'elf';
if (found?.format !== expected || found.arm64 !== arm64) {
  throw new Error(`${file} is ${found === undefined ? 'no shared library this checks' : `${found.format} for ${found.arm64 ? 'arm64' : 'x64'}`}, not ${expected} for ${arm64 ? 'arm64' : 'x64'}`);
}
if (expected === 'elf') {
  const text = bytes.toString('latin1');
  // The C library the file names to the dynamic loader: musl's is `libc.musl-<arch>.so.1`, glibc's `libc.so.6`.
  const wanted = target.endsWith('-musl') ? 'musl' : 'gnu';
  const libc = text.includes('libc.musl-') ? 'musl' : text.includes('libc.so.6') ? 'gnu' : undefined;
  if (libc !== wanted) throw new Error(`${file} links ${libc ?? 'no C library this knows'}, not the ${wanted} of ${target}`);
  // Only glibc versions its symbols. A musl build names GLIBC_2.0 too, through Alpine's libgcc_s, which is no glibc.
  if (libc === 'gnu') {
    const versions = [...text.matchAll(/GLIBC_(\d+)\.(\d+)/g)].map((match) => [Number(match[1]), Number(match[2])] as const);
    const newest = versions.reduce<readonly [number, number] | undefined>((max, version) => (max === undefined || compare(version, max) > 0 ? version : max), undefined);
    if (newest !== undefined && compare(newest, GLIBC_FLOOR) > 0) {
      throw new Error(`${file} needs glibc ${newest.join('.')}, newer than ${GLIBC_FLOOR.join('.')}: build it on Ubuntu 22.04`);
    }
    process.stdout.write(`newest glibc symbol version: ${newest?.join('.') ?? 'none'}\n`);
  }
}
process.stdout.write(`${file}: ${expected} for ${arm64 ? 'arm64' : 'x64'}\n`);

/** The executable format and whether it is for arm64, read from the header; undefined for anything else. */
function format(data: Buffer): { format: 'mach-o' | 'pe' | 'elf'; arm64: boolean } | undefined {
  if (data.length < 64) return undefined;
  // 64-bit Mach-O, little-endian: the CPU type follows the magic.
  if (data.readUInt32LE(0) === 0xfe_ed_fa_cf) {
    const cpu = data.readUInt32LE(4);
    return cpu === 0x01_00_00_0c ? { format: 'mach-o', arm64: true } : cpu === 0x01_00_00_07 ? { format: 'mach-o', arm64: false } : undefined;
  }
  // ELF: e_machine at 18, little-endian on both targets.
  if (data.readUInt32BE(0) === 0x7f_45_4c_46) {
    const machine = data.readUInt16LE(18);
    return machine === 0xb7 ? { format: 'elf', arm64: true } : machine === 0x3e ? { format: 'elf', arm64: false } : undefined;
  }
  // PE: the DOS header points at the PE signature, which the COFF machine field follows.
  if (data.toString('latin1', 0, 2) === 'MZ') {
    const pe = data.readUInt32LE(0x3c);
    if (pe + 6 > data.length || data.toString('latin1', pe, pe + 4) !== 'PE\0\0') return undefined;
    const machine = data.readUInt16LE(pe + 4);
    return machine === 0xaa_64 ? { format: 'pe', arm64: true } : machine === 0x86_64 ? { format: 'pe', arm64: false } : undefined;
  }
  return undefined;
}

/** Orders two `major.minor` versions. */
function compare(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}
