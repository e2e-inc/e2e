/**
 * Browser provisioning for the web engine: pinned Chrome for Testing and
 * Firefox builds in a per-user cache, downloaded on first use.
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InfrastructureError, type EngineDoctorCheck } from '@e2e-dev/core/engine';
import { browserPlatform, executablePath, installBuild, PINS, type BrowserPlatform, type BuildName } from './builds.ts';
import type { BrowserName } from '../browsers.ts';
import { message } from '../errors.ts';
import { mirrorOrigin } from './download.ts';
import { cancelledCheck, withCacheLock, type LockContext, type LockOwner } from './lock.ts';

/** The build `name` runs in this mode, and the `e2e-web install` arguments that install it. */
function buildOf(name: BrowserName, headed: boolean): { readonly browser: BuildName; readonly buildId: string; readonly installArgs: string } {
  const browser = name === 'firefox' ? 'firefox' : headed ? 'chrome' : 'chrome-headless-shell';
  return { browser, buildId: PINS[browser].buildId, installArgs: browser === 'chrome' ? `${name} --headed` : name };
}

/**
 * Where browsers are kept: `E2E_BROWSERS_PATH` when set, else the user's
 * cache directory, shared by every project on the machine.
 */
export function browsersPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['E2E_BROWSERS_PATH'];
  if (configured !== undefined && configured !== '') return path.resolve(configured);
  if (process.platform === 'win32') return path.join(env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'), 'e2e', 'browsers');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'e2e', 'browsers');
  return path.join(env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'), 'e2e', 'browsers');
}

/** This machine's browser platform; throws `BROWSER_INSTALL_FAILED` where no build ships. */
function requirePlatform(): BrowserPlatform {
  const platform = browserPlatform();
  if (platform === undefined) throw new InfrastructureError('BROWSER_INSTALL_FAILED', `no browser builds for ${process.platform} ${process.arch}`);
  return platform;
}

/** The executable of the build `name` runs in this mode, whether or not it is installed yet. */
export function browserExecutable(name: BrowserName, headed: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const { browser, buildId } = buildOf(name, headed);
  return executablePath(browsersPath(env), browser, buildId, requirePlatform());
}

/** Whether the build `name` runs in this mode is on disk. */
function isBrowserInstalled(name: BrowserName, env: NodeJS.ProcessEnv, headed: boolean): boolean {
  try {
    return existsSync(browserExecutable(name, headed, env));
  } catch {
    return false;
  }
}

/** The `browser` check of `e2e doctor`: whether the build the run launches is installed. */
export async function browserCheck(name: BrowserName, env: NodeJS.ProcessEnv, headed: boolean): Promise<EngineDoctorCheck[]> {
  if (isBrowserInstalled(name, env, headed)) return [{ id: 'browser', status: 'pass', message: `${name} is installed` }];
  return [
    {
      id: 'browser',
      status: 'warn',
      message: `${name} is not installed; the first run downloads it, or run "npx @e2e-dev/web install ${buildOf(name, headed).installArgs}" now`,
    },
  ];
}

/** What an installer receives besides the browser names. */
export interface InstallContext {
  /** Receives every line the installer prints: what it downloads, and where. */
  readonly log: (line: string) => void;
  /** Aborts a download in progress. */
  readonly signal?: AbortSignal | undefined;
  /** Environment the installer runs with: the run's, so it fills the cache the workers will launch from. */
  readonly env: NodeJS.ProcessEnv;
  /** Whether the run launches a window, which decides the chromium build it needs. */
  readonly headed: boolean;
}

/**
 * Ensures the given browsers are installed, downloading any missing ones.
 * Called from the engine's `prepare`, once per run before any worker starts,
 * so a download is never charged against a launch timeout and never runs
 * once per worker.
 */
export async function ensureBrowsersInstalled(names: readonly BrowserName[], context: InstallContext): Promise<void> {
  const missing = [...new Set(names)].filter((name) => !isBrowserInstalled(name, context.env, context.headed));
  if (missing.length === 0) return;
  context.log(`Downloading missing browsers (first run): ${missing.join(', ')}...`);
  await installBrowsers(missing, context);
  context.log('Browser download complete.');
}

/** A pinned build `installBuilds` puts in the cache, and how its install reads in the log and in a failure. */
export interface PinnedBuild {
  /** How a failure names it: `chrome-headless-shell 157.0.8103.38`. */
  readonly label: string;
  /** The line logged before its download. */
  readonly announcement: string;
  /** What a failure tells the user to do instead. */
  readonly recovery: string;
  /** The file that is there once the build is installed. */
  readonly executable: string;
  /** Downloads, verifies, and unpacks it for `owner`. */
  readonly install: (owner: LockOwner) => Promise<void>;
}

/**
 * Installs each of `builds` that `cacheDir` lacks, holding the cache's
 * install lock, so two runs that start at once download each build once. A
 * failed install throws `BROWSER_INSTALL_FAILED` naming the build and what
 * to do instead; `context.signal` aborting throws `CANCELLED`.
 */
export async function installBuilds(cacheDir: string, builds: readonly PinnedBuild[], context: LockContext): Promise<void> {
  await withCacheLock(cacheDir, context, async (owner) => {
    for (const build of builds) {
      if (existsSync(build.executable)) continue;
      cancelledCheck(context.signal);
      context.log(build.announcement);
      try {
        await build.install(owner);
      } catch (cause) {
        cancelledCheck(context.signal);
        throw new InfrastructureError('BROWSER_INSTALL_FAILED', `could not install ${build.label}: ${message(cause)}; ${build.recovery}`, { cause });
      }
    }
  });
}

/**
 * Downloads, verifies, and unpacks `names` into the browsers cache, skipping
 * any build already there, under the cache's install lock.
 */
export async function installBrowsers(names: readonly BrowserName[], context: InstallContext): Promise<void> {
  const cacheDir = browsersPath(context.env);
  const platform = requirePlatform();
  const host = mirrorOrigin(context.env);
  const builds = [...new Set(names)].map((name): PinnedBuild => {
    const { browser, buildId, installArgs } = buildOf(name, context.headed);
    const sha256 = PINS[browser].sha256[platform.node];
    return {
      label: `${browser} ${buildId}`,
      announcement: `Downloading ${browser} ${buildId} into ${cacheDir}`,
      recovery: `run "npx @e2e-dev/web install ${installArgs}" (pnpm: "pnpm exec e2e-web install ${installArgs}") manually`,
      executable: executablePath(cacheDir, browser, buildId, platform),
      install: (owner) => installBuild({ build: browser, buildId, platform, cacheDir, sha256, host, owner, env: context.env, signal: context.signal }),
    };
  });
  await installBuilds(cacheDir, builds, context);
}
