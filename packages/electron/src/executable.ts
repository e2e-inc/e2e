/**
 * Which executable a launch starts: the one `electron({ executablePath })`
 * names, else the Electron binary of the `electron` package installed in the
 * project. That package downloads its binary on first use (Electron 45 and
 * later have no install script), so `prepare` fetches it once per run,
 * before the run's clock starts, and a worker only checks it is there.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ConfigurationError, InfrastructureError } from '@e2e-dev/core/engine';

/** The `electron` package a project installed: its directory and the binary it runs. */
interface ElectronPackage {
  readonly directory: string;
  /** The binary's path, read from the package's `path.txt`; undefined before the binary is downloaded. */
  readonly binary: string | undefined;
  readonly version: string;
  /** Where `ELECTRON_OVERRIDE_DIST_PATH` says the binary is, when it is set: no download can fill that directory. */
  readonly override?: string;
}

/** The project's `electron` package, or undefined when the project has none. */
function electronPackage(projectRoot: string): ElectronPackage | undefined {
  let manifest: string;
  try {
    manifest = createRequire(path.join(projectRoot, 'package.json')).resolve('electron/package.json');
  } catch {
    return undefined;
  }
  const directory = path.dirname(manifest);
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  const version = typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string' ? parsed.version : 'unknown';
  const pathFile = path.join(directory, 'path.txt');
  const relative = existsSync(pathFile) ? readFileSync(pathFile, 'utf8').trim() : '';
  // Electron's own index.js takes the binary from ELECTRON_OVERRIDE_DIST_PATH when it is set (a build of your own, Nix).
  const override = process.env['ELECTRON_OVERRIDE_DIST_PATH'];
  const overridden = override !== undefined && override !== '';
  const binary = overridden ? path.join(override, relative === '' ? 'electron' : relative) : relative === '' ? undefined : path.join(directory, 'dist', relative);
  return { directory, binary: binary !== undefined && existsSync(binary) ? binary : undefined, version, ...(overridden && binary !== undefined ? { override: binary } : {}) };
}

/** A missing binary where `ELECTRON_OVERRIDE_DIST_PATH` points: the variable is wrong, and downloading would not help. */
function overrideMissing(binary: string): ConfigurationError {
  return new ConfigurationError('INVALID_CONFIG', `ELECTRON_OVERRIDE_DIST_PATH names the directory of the Electron binary, and none is at ${binary}; fix the variable or unset it`);
}

/** An `executablePath` that names no executable file, with the fix for the common case: a macOS `.app` bundle. */
function notExecutable(resolved: string): ConfigurationError {
  const bundle = /\.app\/?$/.test(resolved) ? `; a macOS app runs as the binary inside its bundle, ${path.join(resolved, 'Contents', 'MacOS', path.basename(resolved, '.app'))}` : '';
  return new ConfigurationError('INVALID_CONFIG', `electron({ executablePath }) names ${resolved}, which is not an executable file${bundle}`);
}

/**
 * Whether a path names a regular file this process may execute: a directory
 * passes the execute-permission check too (search permission), so it is
 * ruled out first. A packaged macOS app is the binary inside the bundle,
 * `MyApp.app/Contents/MacOS/MyApp`, not the `.app` directory.
 */
function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function notInstalled(projectRoot: string): ConfigurationError {
  return new ConfigurationError(
    'INVALID_CONFIG',
    `electron() starts the electron package installed in the project, and ${projectRoot} has none: install it (npm install --save-dev electron), or name an executable with electron({ executablePath })`,
  );
}

/** The executable a launch starts, checked: an `executablePath` that runs, or the project's downloaded Electron binary. */
export async function resolveExecutable(projectRoot: string, executablePath: string | undefined): Promise<string> {
  if (executablePath !== undefined) {
    const resolved = path.resolve(projectRoot, executablePath);
    if (!isExecutableFile(resolved)) throw notExecutable(resolved);
    return resolved;
  }
  const installed = electronPackage(projectRoot);
  if (installed === undefined) throw notInstalled(projectRoot);
  if (installed.binary === undefined && installed.override !== undefined) throw overrideMissing(installed.override);
  if (installed.binary === undefined) {
    throw new InfrastructureError(
      'ELECTRON_INSTALL_FAILED',
      `electron ${installed.version} is installed at ${installed.directory} without its binary; the engine's prepare step downloads it before the first test`,
    );
  }
  return installed.binary;
}

/**
 * Downloads the project's Electron binary when it is missing, with the
 * package's own `install.js` (what its first `require` would run), its
 * output sent to `log`. Nothing to do with `executablePath`, or with the
 * binary in place.
 */
export async function ensureElectronBinary(projectRoot: string, executablePath: string | undefined, log: (line: string) => void, signal: AbortSignal): Promise<void> {
  if (executablePath !== undefined) {
    // Checked once for the run, so a wrong path is one error rather than one per test.
    const resolved = path.resolve(projectRoot, executablePath);
    if (!isExecutableFile(resolved)) throw notExecutable(resolved);
    return;
  }
  const installed = electronPackage(projectRoot);
  if (installed === undefined) throw notInstalled(projectRoot);
  if (installed.binary !== undefined) return;
  if (installed.override !== undefined) throw overrideMissing(installed.override);
  const script = path.join(installed.directory, 'install.js');
  if (!existsSync(script)) {
    throw new InfrastructureError('ELECTRON_INSTALL_FAILED', `electron ${installed.version} at ${installed.directory} has no binary and no install.js to download it with; reinstall the electron package`);
  }
  log(`downloading the Electron ${installed.version} binary`);
  const failure = await new Promise<string | undefined>((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: installed.directory, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let tail = '';
    const read = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) if (line.trim() !== '') log(line.trim());
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (cause) => resolve(cause.message));
    child.on('close', (code) => resolve(code === 0 ? undefined : `install.js exited with ${code}: ${tail.trim()}`));
  });
  if (failure !== undefined) throw new InfrastructureError('ELECTRON_INSTALL_FAILED', `downloading the Electron ${installed.version} binary failed: ${failure}`);
  if (electronPackage(projectRoot)?.binary === undefined) {
    throw new InfrastructureError('ELECTRON_INSTALL_FAILED', `electron ${installed.version}'s install.js finished, but its binary is still missing at ${installed.directory}`);
  }
}

/** For `e2e doctor`: what a run would start, without downloading anything. */
export function describeExecutable(projectRoot: string, executablePath: string | undefined): { readonly status: 'pass' | 'warn' | 'fail'; readonly message: string } {
  if (executablePath !== undefined) {
    const resolved = path.resolve(projectRoot, executablePath);
    return isExecutableFile(resolved)
      ? { status: 'pass', message: `starts ${resolved}` }
      : { status: 'fail', message: notExecutable(resolved).message };
  }
  const installed = electronPackage(projectRoot);
  if (installed === undefined) return { status: 'fail', message: notInstalled(projectRoot).message };
  if (installed.binary === undefined && installed.override !== undefined) return { status: 'fail', message: overrideMissing(installed.override).message };
  if (installed.binary === undefined) return { status: 'warn', message: `electron ${installed.version} is installed without its binary; the first run downloads it` };
  return { status: 'pass', message: `electron ${installed.version} at ${installed.binary}` };
}

/**
 * Why `app.appPath` names no app Electron can start, or undefined when it
 * does: a main script, or a directory whose `package.json` names an existing
 * `main` (else Electron runs its `index.js`).
 */
export function appPathProblem(projectRoot: string, appPath: string): string | undefined {
  const resolved = path.resolve(projectRoot, appPath);
  if (!existsSync(resolved)) return `app.appPath names ${resolved}, which does not exist`;
  if (statSync(resolved).isFile()) return undefined;
  const manifest = path.join(resolved, 'package.json');
  let main = 'index.js';
  if (existsSync(manifest)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && 'main' in parsed && typeof parsed.main === 'string' && parsed.main !== '') main = parsed.main;
    } catch {
      return `app.appPath names ${resolved}, whose package.json is not valid JSON`;
    }
  }
  const script = path.resolve(resolved, main);
  if (!existsSync(script) && !existsSync(`${script}.js`)) return `app.appPath names ${resolved}, and its main script ${script} does not exist; set "main" in its package.json`;
  return undefined;
}
