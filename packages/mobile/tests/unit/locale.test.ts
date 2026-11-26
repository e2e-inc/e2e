/**
 * The default `adb` runner: where it finds `adb`, and what it reports for a
 * clean exit, a failing one, and none at all. A stub script stands in for
 * `adb`, under a temporary SDK root and home, so the machine's own Android
 * SDK is never found.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAdb } from '../../src/locale.ts';

describe.skipIf(process.platform === 'win32')('runAdb', () => {
  let root: string;
  let env: Record<string, string>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'e2e-adb-'));
    mkdirSync(path.join(root, 'home'));
    mkdirSync(path.join(root, 'empty'));
    env = { HOME: path.join(root, 'home'), PATH: path.join(root, 'empty') };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Puts an `adb` script under `<sdk>/platform-tools` that prints its arguments and exits with the first one after `exit`. */
  function stubAdb(sdk: string): void {
    mkdirSync(path.join(sdk, 'platform-tools'), { recursive: true });
    const adb = path.join(sdk, 'platform-tools', 'adb');
    writeFileSync(adb, '#!/bin/sh\necho "$@"\n[ "$1" = exit ] && { echo failed >&2; exit "$2"; }\nexit 0\n');
    chmodSync(adb, 0o755);
  }

  it('runs the adb under ANDROID_SDK_ROOT before ANDROID_HOME, and returns its output and exit code', async () => {
    stubAdb(path.join(root, 'sdk-root'));
    const signal = new AbortController().signal;
    await expect(runAdb(['-s', 'emulator-5554', 'shell', 'true'], { ...env, ANDROID_SDK_ROOT: path.join(root, 'sdk-root'), ANDROID_HOME: path.join(root, 'nowhere') }, signal)).resolves.toEqual({
      stdout: '-s emulator-5554 shell true\n',
      stderr: '',
      exitCode: 0,
    });
    stubAdb(path.join(root, 'home-sdk'));
    await expect(runAdb(['exit', '3'], { ...env, ANDROID_HOME: path.join(root, 'home-sdk') }, signal)).resolves.toEqual({
      stdout: 'exit 3\n',
      stderr: 'failed\n',
      exitCode: 3,
    });
  });

  it('reports a missing adb as ENGINE_FAILURE, with how to install it', async () => {
    await expect(runAdb(['devices'], env, new AbortController().signal)).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('install the Android SDK platform-tools, and set ANDROID_HOME or put adb on PATH'),
    });
  });
});
