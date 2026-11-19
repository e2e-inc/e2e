/**
 * `launch` from `@e2e-dev/core` given up on while its host opens, by an
 * engine whose `init` finishes all the same: the failure is the classified
 * error the caller's signal aborted with (its own deadline), and `CANCELLED`
 * for a signal aborted with nothing.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launch } from '@e2e-dev/core';
import { defineEngine, TestError } from '@e2e-dev/core/engine';

describe('launch given up on while its host opens', () => {
  let cwd = '';

  beforeEach(() => {
    cwd = mkdtempSync(path.join(os.tmpdir(), 'e2e-core-launch-abort-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Launches an engine whose `init` runs `during` and then finishes, whatever became of its signal. */
  function launchDuring(during: () => void, signal: AbortSignal) {
    const engine = defineEngine({
      name: 'toy',
      version: '1.0.0',
      spiVersion: 1,
      init: async () => during(),
    });
    return launch(engine, { cwd, env: {}, handleSignals: false, signal });
  }

  it('fails as the deadline its signal aborted with', async () => {
    const caller = new AbortController();
    const deadline = new TestError('TEST_TIMEOUT', 'the attach ran out of time');
    await expect(launchDuring(() => caller.abort(deadline), caller.signal)).rejects.toMatchObject({
      category: 'test',
      code: 'TEST_TIMEOUT',
      message: 'the attach ran out of time',
    });
  });

  it('fails as cancelled when its signal aborted with nothing', async () => {
    const caller = new AbortController();
    await expect(launchDuring(() => caller.abort(), caller.signal)).rejects.toMatchObject({
      category: 'infrastructure',
      code: 'CANCELLED',
      message: 'opening a host on target "toy" was cancelled',
    });
  });
});
