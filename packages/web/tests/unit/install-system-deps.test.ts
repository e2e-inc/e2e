/**
 * `installSystemDeps`, and `e2e-web install --with-deps` around it, on a
 * machine made to look like Debian: a fake `sudo` and `apt-get` on the PATH
 * record what apt is asked for, and `apt-get update` only returns once the
 * test lets it.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../../src/cli.ts';
import { browserExecutable } from '../../src/install/provision.ts';
import { installSystemDeps } from '../../src/install/system-deps.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, existsSync: (file: string) => file === '/usr/bin/apt-get' || fs.existsSync(file) };
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

let dir = '';
let calls = '';
let released = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'e2e-apt-'));
  calls = path.join(dir, 'calls');
  released = path.join(dir, 'released');
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const fake = [
    '#!/bin/sh',
    `echo "$(basename "$0") $*" >> "${calls}"`,
    'case "$*" in *update)',
    '  tries=0',
    `  until [ -e "${released}" ]; do`,
    '    tries=$((tries + 1))',
    '    [ "$tries" -gt 300 ] && exit 1',
    '    sleep 0.01',
    '  done ;;',
    'esac',
    '',
  ].join('\n');
  for (const name of ['sudo', 'apt-get']) {
    writeFileSync(path.join(bin, name), fake);
    chmodSync(path.join(bin, name), 0o755);
  }
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`);
  Object.defineProperty(process, 'platform', { value: 'linux' });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** The commands apt was asked for so far, in order, as root or through sudo. */
function asked(): string[] {
  return readFileSync(calls, 'utf8').trim().split('\n').map((line) => line.replace(/^sudo /, ''));
}

it.skipIf(platform.value === 'win32')('runs apt without blocking the event loop, so a signal can cancel the install meanwhile', async () => {
  const logs: string[] = [];
  const loop = setImmediate(() => writeFileSync(released, ''));
  try {
    await installSystemDeps(['chromium'], (line) => logs.push(line), new AbortController().signal);
  } finally {
    clearImmediate(loop);
  }
  const commands = asked();
  expect(commands[0]).toBe('apt-get update');
  expect(commands.slice(1, -1)).toHaveLength(11);
  for (const probe of commands.slice(1, -1)) expect(probe).toMatch(/^apt-get install --simulate --no-install-recommends \S+$/);
  expect(commands.at(-1)).toMatch(/^apt-get satisfy -y --no-install-recommends fonts-noto-color-emoji, .*, libasound2t64 \| libasound2, .*, libxrandr2$/);
  expect(logs).toEqual([expect.stringMatching(/^Installing system packages: fonts-noto-color-emoji .* libasound2t64 .* libxrandr2$/)]);
});

it.skipIf(platform.value === 'win32')('starts no further command once cancelled, and fails with CANCELLED', async () => {
  const controller = new AbortController();
  const logs: string[] = [];
  const loop = setImmediate(() => {
    controller.abort();
    writeFileSync(released, '');
  });
  try {
    await expect(installSystemDeps(['chromium'], (line) => logs.push(line), controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  } finally {
    clearImmediate(loop);
  }
  expect(asked()).toEqual(['apt-get update']);
  expect(logs).toEqual([]);
});

it.skipIf(platform.value === 'win32')('e2e-web install --with-deps runs apt before the install, outside the cache\'s install lock', async () => {
  const cache = path.join(dir, 'browsers');
  vi.stubEnv('E2E_BROWSERS_PATH', cache);
  const executable = browserExecutable('chromium', false);
  mkdirSync(path.dirname(executable), { recursive: true });
  writeFileSync(executable, '');
  let stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
    stderr += String(text);
    return true;
  });
  const running = main(['install', 'chromium', '--with-deps']);
  await vi.waitFor(() => expect(existsSync(calls)).toBe(true), { timeout: 10_000 });
  expect(existsSync(path.join(cache, '.install.lock'))).toBe(false);
  writeFileSync(released, '');
  expect(await running).toBe(0);
  expect(asked().at(-1)).toMatch(/^apt-get satisfy -y --no-install-recommends /);
  expect(stderr).toMatch(/^Installing system packages: .* libxrandr2\n$/);
});
