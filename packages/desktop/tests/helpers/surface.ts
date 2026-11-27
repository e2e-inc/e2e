/**
 * A `DesktopSurface` on the scripted driver, for tests of one capability at
 * a time: initialized on a target's app, with the app launched (a real child
 * process standing in for it) when asked. `cleanUp` disposes every surface
 * made and kills what the fakes started; call it after each test.
 */

import { rmSync } from 'node:fs';
import type { EngineAppInfo, OperationContext } from '@e2e-dev/core/engine';
import { resolveOptions } from '../../src/options.ts';
import { DesktopSurface } from '../../src/surface.ts';
import { fakeDriver, killSpawned, type FakeDriver, type Scenario } from './fake-driver.ts';

const signal = new AbortController().signal;
const surfaces: DesktopSurface[] = [];
const directories: string[] = [];

/** Disposes every surface made, kills the processes the fakes started, and removes the directories made for them. */
export async function cleanUp(): Promise<void> {
  for (const surface of surfaces.splice(0)) await surface.dispose({ signal, timeoutMs: 2_000 }).catch(() => undefined);
  killSpawned();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

/** An operation with a 10 s budget. */
export function operation(overrides: Partial<OperationContext> = {}): OperationContext {
  return { signal, timeoutMs: 10_000, runId: 'run', attemptId: 'attempt', origin: 'test', ...overrides };
}

interface Options {
  readonly app?: EngineAppInfo;
  readonly projectRoot?: string;
}

/** A surface on the scripted driver, initialized with nothing launched. */
export async function initialized(scenario: Scenario | FakeDriver = {}, { app = { bundleId: 'dev.e2e.spike.form' }, projectRoot = process.cwd() }: Options = {}) {
  const fake = 'calls' in scenario ? scenario : fakeDriver(scenario);
  const surface = new DesktopSurface(resolveOptions({ settle: false }), 'macos', () => fake);
  surfaces.push(surface);
  await surface.init({ runId: 'run', targetName: 'macos', projectRoot, app, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  return { surface, fake };
}

/** A surface with the app launched. */
export async function launched(scenario: Scenario | FakeDriver = {}, options: Options = {}) {
  const made = await initialized(scenario, options);
  await made.surface.restart(operation());
  return made;
}
