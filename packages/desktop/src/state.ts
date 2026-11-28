/**
 * The saved state of the app a project builds, for `app.clearState()` and
 * `test.setup` sessions. macOS keys it by bundle id, not by bundle: every
 * copy of an app with one id shares one defaults domain, served by
 * `cfprefsd`, which a redirected home (`CFFIXED_USER_HOME`) does not move.
 * Replacing it for a build would replace it for an installed copy of the
 * same app, the user's own data. So the engine replaces it only for an
 * `app.appPath` target, and only while macOS knows no other copy of the
 * bundle id, installed or running, checked before anything is touched.
 *
 * What a reset clears, by the bundle id:
 * - the defaults domain (`defaults delete`);
 * - the saved application state, `~/Library/Saved Application State/<id>.savedState`;
 * - a sandboxed build's container, `~/Library/Containers/<id>`, files and preferences.
 *
 * Not covered: files an unsandboxed app writes under a name of its own
 * (`~/Library/Application Support/<name>`, caches, documents), app group
 * containers, and the Keychain. A session carries the defaults domain only:
 * restoring one resets the app as above, then writes the saved defaults.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { EngineError, type EngineState } from '@e2e-dev/core/engine';
import { call, translate, type DesktopDriver } from './driver.ts';

const execFileAsync = promisify(execFile);

/** The format a captured session carries. */
const FORMAT = 'macos-app-state';
const VERSION = 1;
/** How long one `defaults` or `mdfind` command may take. */
const COMMAND_MS = 10_000;
/**
 * A bundle id an app can have: two or more segments of letters, digits, hyphens, and underscores (which `codesign`
 * and LaunchServices take), joined by single periods, not starting with a hyphen. Checked before it goes into a
 * Spotlight query, and before it names a directory a reset removes, where `.` or `..` would name the directory above.
 * The period and the first character also keep out the names `defaults` reads as the global domain (`-g`,
 * `-globalDomain`, `NSGlobalDomain`), whose delete would clear the user's own preferences.
 */
const BUNDLE_ID = /^(?!-)[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;

/** A defaults export whose root dictionary holds nothing, as `defaults export` writes an empty domain. */
const EMPTY_DOMAIN = /<plist[^>]*>\s*(?:<dict\s*\/>|<dict>\s*<\/dict>)\s*<\/plist>\s*$/;

/** How many other copies an error names. */
const NAMED_COPIES = 3;

/** What the state commands ask of the machine, behind a seam so tests never touch a real defaults domain. */
export interface StateHost {
  /** The user's home, under which the saved state and container live. */
  readonly home: string;
  /** The bundles LaunchServices or Spotlight knows with this id, and the processes running one. */
  copies(bundleId: string, signal: AbortSignal): Promise<{ readonly paths: readonly string[]; readonly running: readonly { readonly pid: number; readonly path?: string }[] }>;
  /** The defaults domain as an XML property list; an empty dictionary for a domain with nothing in it. */
  exportDefaults(bundleId: string, signal: AbortSignal): Promise<string>;
  /** Writes a property list into the domain, merged with what it holds. */
  importDefaults(bundleId: string, plist: string, signal: AbortSignal): Promise<void>;
  /** Removes the whole domain; a domain that does not exist is nothing to remove. */
  deleteDefaults(bundleId: string, signal: AbortSignal): Promise<void>;
}

/** The machine itself: LaunchServices through the driver, Spotlight through `mdfind`, defaults through `/usr/bin/defaults`. */
export function nativeStateHost(driver: () => DesktopDriver): StateHost {
  return {
    home: homedir(),
    async copies(bundleId, signal) {
      const copies = await call(() => driver().bundleCopies(bundleId), { label: `look up the copies of ${bundleId}`, input: false, signal, timeoutMs: COMMAND_MS }).catch((cause: unknown) => {
        throw translate(cause, `look up the copies of ${bundleId}`, false);
      });
      // Spotlight finds a copy LaunchServices never registered, such as one a build left in another directory. Spotlight
      // turned off finds nothing, which leaves LaunchServices' answer; a Spotlight that did not answer in time is no
      // evidence there is no other copy, so the check fails.
      const indexed = await execFileAsync('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], { signal, timeout: COMMAND_MS }).then(
        ({ stdout }) => stdout.split('\n').filter((line) => line !== ''),
        (cause: unknown) => {
          if (signal.aborted) throw cause;
          if ((cause as { killed?: boolean }).killed === true) {
            throw new EngineError('OPERATION_TIMEOUT', `Spotlight did not answer in time, so no other copy of ${bundleId} could be ruled out`, { retryable: false });
          }
          return [];
        },
      );
      return { paths: [...copies.registered, ...indexed], running: copies.running };
    },
    async exportDefaults(bundleId, signal) {
      const { stdout } = await execFileAsync('/usr/bin/defaults', ['export', bundleId, '-'], { signal, timeout: COMMAND_MS, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    },
    async importDefaults(bundleId, plist, signal) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('/usr/bin/defaults', ['import', bundleId, '-'], { signal, timeout: COMMAND_MS, stdio: ['pipe', 'ignore', 'pipe'] });
        let errors = '';
        child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
        child.once('error', reject);
        // A `defaults` that exits before it read the whole plist closes the pipe: the exit below says why, not an unhandled EPIPE.
        child.stdin.once('error', () => undefined);
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`defaults import exited with ${String(code)}: ${errors.trim()}`))));
        child.stdin.end(plist);
      });
    },
    async deleteDefaults(bundleId, signal) {
      // `defaults delete` fails on a domain that does not exist, which is the state wanted.
      await execFileAsync('/usr/bin/defaults', ['delete', bundleId], { signal, timeout: COMMAND_MS }).catch((cause: unknown) => {
        if (/not found/i.test(String((cause as { stderr?: unknown }).stderr ?? ''))) return;
        throw cause;
      });
    },
  };
}

/** The build whose state may be replaced: the target's `appPath` bundle, resolved, and its bundle id. */
export interface OwnedBuild {
  readonly path: string;
  readonly bundleId: string;
}

/** The refusal for a target that names an installed app. */
export function installedApp(what: string, bundleId: string | undefined): EngineError {
  return new EngineError(
    'UNSUPPORTED_CAPABILITY',
    `${what}: the desktop engine saves, restores, and clears an app's saved state only for an app.appPath target, a build the project makes. ${bundleId === undefined ? 'This target' : `"${bundleId}"`} is an installed app, whose defaults and saved state are the user's own`,
    { retryable: false },
  );
}

/** The saved state of one target's build: checked, reset, captured, and restored through a `StateHost`. */
export class AppState {
  constructor(private readonly host: StateHost) {}

  /**
   * Refuses, touching nothing, while macOS knows another copy of the build's
   * bundle id: a bundle elsewhere on disk, installed or built, or a process
   * not the engine's running one (`ownPid`). They share the defaults domain
   * the engine is about to replace. A registration whose bundle is gone is no
   * copy.
   */
  async requireSole(build: OwnedBuild, what: string, signal: AbortSignal, ownPid?: number): Promise<void> {
    if (!BUNDLE_ID.test(build.bundleId)) {
      throw new EngineError('UNSUPPORTED_CAPABILITY', `${what}: the bundle id "${build.bundleId}" has characters macOS does not allow in one, so its other copies cannot be looked up`, { retryable: false });
    }
    const copies = await this.host.copies(build.bundleId, signal);
    const own = await realpath(build.path).catch(() => build.path);
    const others = new Set<string>();
    for (const candidate of copies.paths) {
      if (!existsSync(candidate)) continue;
      const resolved = await realpath(candidate).catch(() => candidate);
      if (resolved !== own) others.add(resolved);
    }
    // A copy of the build itself that the engine did not launch (one the developer opened) shares the domain too.
    const running = copies.running.filter((copy) => copy.pid !== ownPid);
    if (others.size === 0 && running.length === 0) return;
    const named = [...others].slice(0, NAMED_COPIES).join(', ');
    const more = others.size > NAMED_COPIES ? ` and ${others.size - NAMED_COPIES} more` : '';
    const where = [
      ...(others.size > 0 ? [`at ${named}${more}`] : []),
      ...(running.length > 0 ? [`running as process ${running.map((copy) => copy.pid).join(', ')}`] : []),
    ].join(', and ');
    throw new EngineError(
      'UNSUPPORTED_CAPABILITY',
      `${what}: the saved state of "${build.bundleId}" is shared by every copy of the app with that bundle id, and macOS knows another copy ${where}. Nothing was changed. Give the build a bundle id of its own (a ".e2e" suffix in the configuration you test), or remove the other copy`,
      { retryable: false },
    );
  }

  /** Clears what macOS keeps of the app by its bundle id; see the top of this module. The app must not be running. */
  async reset(bundleId: string, signal: AbortSignal): Promise<void> {
    // Checked here too, not only by `requireSole`: the id names directories this removes, and `..` would name their parent.
    if (!BUNDLE_ID.test(bundleId)) throw new EngineError('UNSUPPORTED_CAPABILITY', `the bundle id "${bundleId}" is not one macOS allows, so its saved state is not removed`, { retryable: false });
    await this.host.deleteDefaults(bundleId, signal);
    for (const directory of this.directories(bundleId)) {
      await rm(directory, { recursive: true, force: true }).catch((cause: unknown) => {
        throw new EngineError(
          'ENGINE_FAILURE',
          `could not remove ${directory}: ${(cause as Error).message}. macOS can ask before one app changes another's container: allow the app that starts e2e when it asks, or give it Full Disk Access, then run again`,
          { retryable: false, cause },
        );
      });
    }
  }

  /** The app's defaults, as a session keeps them. */
  async capture(bundleId: string, signal: AbortSignal): Promise<EngineState> {
    return { format: FORMAT, version: VERSION, data: { bundleId, defaults: await this.host.exportDefaults(bundleId, signal) } };
  }

  /** Resets the app and writes the session's defaults, so nothing of the state before carries over. The app must not be running. */
  async restore(bundleId: string, state: EngineState, signal: AbortSignal): Promise<void> {
    const defaults = savedDefaults(state, bundleId);
    await this.reset(bundleId, signal);
    // A root dictionary with nothing in it is a domain with nothing in it, which the reset left. An empty dictionary
    // nested in a full one is a value like any other.
    if (!EMPTY_DOMAIN.test(defaults)) await this.host.importDefaults(bundleId, defaults, signal);
  }

  /** The directories a reset removes. */
  private directories(bundleId: string): readonly string[] {
    const library = path.join(this.host.home, 'Library');
    return [path.join(library, 'Saved Application State', `${bundleId}.savedState`), path.join(library, 'Containers', bundleId)];
  }
}

/** The defaults a session saved for this bundle id; a session another engine or app wrote is refused, never applied. */
function savedDefaults(state: EngineState, bundleId: string): string {
  const data = state.data as { bundleId?: unknown; defaults?: unknown } | null;
  if (state.format !== FORMAT || state.version !== VERSION || typeof data !== 'object' || data === null || typeof data.defaults !== 'string') {
    throw new EngineError('INVALID_STATE', 'the saved session is not one this version of the desktop engine wrote; run its setup test again', { retryable: false });
  }
  if (data.bundleId !== bundleId) throw new EngineError('INVALID_STATE', `the saved session belongs to another app, not "${bundleId}"; run its setup test again`, { retryable: false });
  return data.defaults;
}
