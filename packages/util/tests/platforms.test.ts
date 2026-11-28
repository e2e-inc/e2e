/**
 * The platforms the loader asks for, the platform packages under `npm/`, and
 * the optional dependencies that install them name the same eight builds, each
 * package selected by the `os`, `cpu`, and `libc` its name says. On a platform
 * with none of them, the first call fails naming the ones there are.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeUtilUnavailableError, pngSize } from '../src/index.ts';

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly main?: string;
  readonly files?: readonly string[];
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  readonly libc?: readonly string[];
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

const root = path.join(import.meta.dirname, '..');
const read = (file: string): Manifest => JSON.parse(readFileSync(path.join(root, file), 'utf8')) as Manifest;
const util = read('package.json');
const packages = readdirSync(path.join(root, 'npm')).toSorted();
const supported = new NativeUtilUnavailableError('', { packageName: undefined, platform: 'none', notInstalled: false }).supported;

describe('platform packages', () => {
  it('are the platforms the loader asks for, each an optional dependency', () => {
    expect(packages).toEqual([...supported].toSorted());
    expect(Object.keys(util.optionalDependencies ?? {}).toSorted()).toEqual(packages.map((platform) => `@e2e-dev/util-${platform}`));
  });

  it.each(packages)('%s installs only where its name says, with its addon as main, at the version of @e2e-dev/util', (platform) => {
    const manifest = read(`npm/${platform}/package.json`);
    const [os, cpu, abi] = platform.split('-');
    expect(manifest.name).toBe(`@e2e-dev/util-${platform}`);
    expect(manifest.version).toBe(util.version);
    expect(manifest.os).toEqual([os]);
    expect(manifest.cpu).toEqual([cpu]);
    expect(manifest.libc).toEqual(abi === 'gnu' ? ['glibc'] : abi === 'musl' ? ['musl'] : undefined);
    expect(manifest.main).toBe(`util.${platform}.node`);
    expect(manifest.files).toEqual([`util.${platform}.node`, 'NOTICE', 'THIRD_PARTY_LICENSES.md']);
  });
});

describe('on a platform with no build', () => {
  it('fails the first call naming the platforms there are', () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'freebsd' });
    try {
      expect(() => pngSize(new Uint8Array(8))).toThrow(new RegExp(`no native build for freebsd-${process.arch}; it has one for darwin-arm64, .*win32-arm64-msvc`));
    } finally {
      if (real !== undefined) Object.defineProperty(process, 'platform', real);
    }
  });
});
