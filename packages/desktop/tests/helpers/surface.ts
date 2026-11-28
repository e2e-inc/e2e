/**
 * A `DesktopSurface` on the scripted driver, for tests of one capability at
 * a time: initialized on a target's app, with the app launched (a real child
 * process standing in for it) when asked. `cleanUp` disposes every surface
 * made and kills what the fakes started; call it after each test.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EngineAppInfo, OperationContext } from '@e2e-dev/core/engine';
import { resolveOptions, type DesktopOptions } from '../../src/options.ts';
import type { StateHost } from '../../src/state.ts';
import { DesktopSurface } from '../../src/surface.ts';
import { fakeDriver, killSpawned, type FakeDriver, type Scenario } from './fake-driver.ts';

const signal = new AbortController().signal;
const surfaces: DesktopSurface[] = [];
const directories: string[] = [];

/** Disposes every surface made, kills the processes the fakes started, and removes the directories `scratch` made. */
export async function cleanUp(): Promise<void> {
  for (const surface of surfaces.splice(0)) await surface.dispose({ signal, timeoutMs: 2_000 }).catch(() => undefined);
  killSpawned();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

/** A new empty directory, removed by `cleanUp`. */
export function scratch(prefix = 'desktop-test-'): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** An operation with a 10 s budget. */
export function operation(overrides: Partial<OperationContext> = {}): OperationContext {
  return { signal, timeoutMs: 10_000, runId: 'run', attemptId: 'attempt', origin: 'test', ...overrides };
}

interface Options {
  readonly app?: EngineAppInfo;
  readonly projectRoot?: string;
  /** What the state commands ask of the machine; the real one by default. */
  readonly stateHost?: StateHost;
  /** Engine options besides `settle`, which is off. */
  readonly options?: Omit<DesktopOptions, 'settle'>;
}

/** A surface on the scripted driver, initialized with nothing launched. */
export async function initialized(scenario: Scenario | FakeDriver = {}, { app = { bundleId: 'dev.e2e.spike.form' }, projectRoot = process.cwd(), stateHost, options }: Options = {}) {
  const fake = 'calls' in scenario ? scenario : fakeDriver(scenario);
  const surface = new DesktopSurface(resolveOptions({ ...options, settle: false }), 'macos', () => fake, stateHost === undefined ? undefined : () => stateHost);
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

/** Starts an attempt whose artifacts go to a new directory, which it answers. */
export async function attempt(surface: DesktopSurface): Promise<string> {
  const artifactsDir = scratch('artifacts-');
  await surface.startAttempt({ attemptId: 'a', artifactsDir, resolveSecret: async () => '', signal, appLog: () => undefined, navigation: () => undefined, environment: () => undefined });
  return artifactsDir;
}
