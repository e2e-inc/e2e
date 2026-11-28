/**
 * `revylDesktop()`: the desktop engine, run on a Revyl Mac computer and
 * driven from the runner over the engine protocol.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { desktop, type DesktopOptions } from '@e2e-dev/desktop/engine';
import { ConfigurationError, connectEngine, describeEngine, type EngineHandle, type JsonValue } from 'e2e/engine';
import { computerTransport } from './transport.ts';

/** Revyl's computer ids are UUIDs. */
const COMPUTER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The desktop engine's options, and where it runs. */
export interface RevylDesktopOptions extends DesktopOptions {
  /**
   * Id of a persistent Revyl computer to run on; blank names none. One that runs is used as it
   * is and left running; one that is stopped is started for the run and
   * stopped after it, keeping its disk. Without it, each run creates a Mac
   * and stops it at the end, which deletes it.
   */
  readonly computer?: string | undefined;
  /** Seconds a computer the run creates or starts lives at most, so Revyl stops it even when the run cannot. Default 3600, from 300 to 86400. */
  readonly lifetimeSeconds?: number | undefined;
}

/**
 * The desktop engine on a Revyl Mac computer:
 * `{ engine: revylDesktop(), app: { bundleId: 'com.apple.calculator' } }`.
 * The engine runs on the Mac, under the same version of
 * `@e2e-dev/desktop` and `@e2e-dev/core` as the runner's, and the runner
 * drives it over the engine protocol. A target's `appPath` build is
 * uploaded to the Mac. `REVYL_API_KEY` comes from the run's environment,
 * and `REVYL_API_URL` when set.
 */
export function revylDesktop(options: RevylDesktopOptions = {}): EngineHandle {
  const { computer: named, lifetimeSeconds = 3600, ...desktopOptions } = options;
  // A blank id, as an unset variable in CI reads, names no computer.
  const computer = typeof named === 'string' && named.trim() === '' ? undefined : named;
  if (computer !== undefined && (typeof computer !== 'string' || !COMPUTER_ID.test(computer))) {
    throw new ConfigurationError('INVALID_CONFIG', 'revylDesktop: `computer` must be the id of a Revyl computer, a UUID');
  }
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 300 || lifetimeSeconds > 86_400) {
    throw new ConfigurationError('INVALID_CONFIG', 'revylDesktop: `lifetimeSeconds` must be a whole number of seconds from 300 to 86400');
  }
  // Built here only to check the options and describe the engine the Mac serves.
  const local = desktop(desktopOptions);
  return connectEngine({
    manifest: describeEngine(local),
    transport: computerTransport({ computer, lifetimeSeconds, packages: enginePackages() }),
    // What the Mac's \`desktop()\` gets, without the unset options JSON cannot carry.
    initializationOptions: Object.fromEntries(Object.entries(desktopOptions).filter(([, value]) => value !== undefined)) as JsonValue,
    ...(local.validateApp === undefined ? {} : { validateApp: local.validateApp }),
  });
}

/** `@e2e-dev/desktop` and the `@e2e-dev/core` it runs on, at the versions this project has, as npm installs them on the Mac. */
function enginePackages(): string[] {
  const desktopEntry = createRequire(import.meta.url).resolve('@e2e-dev/desktop/engine');
  const coreEntry = createRequire(desktopEntry).resolve('@e2e-dev/core/engine');
  return [`@e2e-dev/desktop@${versionAbove(desktopEntry, '@e2e-dev/desktop')}`, `@e2e-dev/core@${versionAbove(coreEntry, '@e2e-dev/core')}`];
}

/** The version in the nearest `package.json` above `file` that names `name`. */
function versionAbove(file: string, name: string): string {
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (typeof manifest === 'object' && manifest !== null && 'name' in manifest && manifest.name === name && 'version' in manifest && typeof manifest.version === 'string') {
        return manifest.version;
      }
    } catch {
      // No package.json here; keep going up.
    }
  }
  throw new ConfigurationError('INVALID_CONFIG', `revylDesktop: cannot find the version of ${name} installed beside ${file}`);
}
