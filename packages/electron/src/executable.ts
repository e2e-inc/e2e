/**
 * Which executable a launch starts: the one `electron({ executablePath })`
 * names, else the Electron binary of the `electron` package installed in the
 * project. That package downloads its binary on first use (Electron 45 and
 * later have no install script), so `prepare` fetches it once per run,
 * before the run's clock starts, and a worker only checks it is there.
 */

import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ConfigurationError, InfrastructureError } from '@e2e-dev/core/engine';

/** How much of a failed download's output its error quotes, in characters. */
const INSTALL_OUTPUT_TAIL = 2000;

/** The `electron` package a project installed: its directory and the binary it runs. */
interface ElectronPackage {
  readonly directory: string;
  /** The binary's path, read from the package's `path.txt`; undefined before the binary is downloaded. */
  readonly binary: string | undefined;
  readonly version: string;
  /** Where `ELECTRON_OVERRIDE_DIST_PATH` says the binary is, when it is set: no download can fill that directory. */
  readonly override?: string;
}

/** The environment a lookup reads and a download runs in: the run's, which a host may hand other than this process's own. */
type RunEnv = Readonly<Record<string, string | undefined>>;

/** The project's `electron` package, or undefined when the project has none. */
function electronPackage(projectRoot: string, env: RunEnv): ElectronPackage | undefined {
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
  const override = env['ELECTRON_OVERRIDE_DIST_PATH'];
  const overridden = override !== undefined && override !== '';
  const binary = overridden ? path.join(override, relative === '' ? 'electron' : relative) : relative === '' ? undefined : path.join(directory, 'dist', relative);
  return { directory, binary: binary !== undefined && existsSync(binary) ? binary : undefined, version, ...(overridden && binary !== undefined ? { override: binary } : {}) };
}

/**
 * Whether a path names a regular file this process may execute: a directory
 * passes the execute-permission check too (search permission), so it is
 * ruled out first. A packaged macOS app is the binary inside the bundle,
 * `MyApp.app/Contents/MacOS/MyApp`, not the `.app` directory. Windows has no
 * execute permission, and starts only a program image: a file that begins
 * with the `MZ` signature, which a shortcut or a script does not.
 */
function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32') {
      accessSync(file, constants.X_OK);
      return true;
    }
    const signature = Buffer.alloc(2);
    const handle = openSync(file, 'r');
    try {
      return readSync(handle, signature, 0, 2, 0) === 2 && signature.toString('latin1') === 'MZ';
    } finally {
      closeSync(handle);
    }
  } catch {
    return false;
  }
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** The names in a directory, or none when it cannot be read. */
function entries(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/** How many `.exe` files of a folder a hint names. */
const NAMED_EXECUTABLES = 5;

/**
 * Where a Squirrel.Windows launcher's app is, when `file` is one: an
 * installer made with Squirrel (electron-winstaller, Electron Forge's
 * default) puts the app in `app-<version>` folders beside `Update.exe`, and
 * a small launcher of the app's name next to them. The launcher starts one
 * of the versions and exits, so the engine would be left holding a process
 * that is not the app. One installed version is named by its path; of
 * several, the launcher's pick is its own rule, so their folders are named.
 */
function squirrelApp(file: string): string | undefined {
  const directory = path.dirname(file);
  const name = path.basename(file);
  const siblings = entries(directory);
  if (!siblings.some((sibling) => sibling.toLowerCase() === 'update.exe')) return undefined;
  const versions = siblings.filter((sibling) => /^app-\d/.test(sibling) && existsSync(path.join(directory, sibling, name))).toSorted();
  const [only] = versions;
  if (only === undefined) return undefined;
  return versions.length === 1 ? path.join(directory, only, name) : `${name} in one of the version folders beside it (${versions.join(', ')})`;
}

/** What to name instead of an `executablePath` that is no executable file, for the mistakes each platform invites. */
function executableHint(resolved: string, platform: NodeJS.Platform): string {
  if (/\.app[\\/]?$/.test(resolved)) return `; a macOS app runs as the binary inside its bundle, ${path.join(resolved, 'Contents', 'MacOS', path.basename(resolved, '.app'))}`;
  if (platform !== 'win32') return '';
  if (/\.lnk$/i.test(resolved)) return '; it is a shortcut: name the .exe it points to (its Target, under Properties)';
  if (isExecutableFile(`${resolved}.exe`, platform)) return `; name the file with its extension, ${squirrelApp(`${resolved}.exe`) ?? `${resolved}.exe`}`;
  if (!isDirectory(resolved)) return '';
  const programs = entries(resolved)
    .filter((name) => /\.exe$/i.test(name))
    .toSorted();
  if (programs.length === 0) return '; name the app\'s .exe, not a folder';
  // A Squirrel install's own folder: the app is not the launcher at its top.
  const installed = programs.map((name) => squirrelApp(path.join(resolved, name))).find((app) => app !== undefined);
  if (installed !== undefined) return `; name the app's .exe, ${installed}`;
  return `; name the app's .exe inside the folder (it holds ${programs.slice(0, NAMED_EXECUTABLES).join(', ')}${programs.length > NAMED_EXECUTABLES ? ', and more' : ''})`;
}

/** What a launch would start, or why it has nothing to start: the one answer `prepare`, `init`, and `doctor` each act on. */
type Executable =
  /** An `executablePath` that runs. */
  | { readonly kind: 'named'; readonly file: string }
  /** The project's Electron binary, downloaded. */
  | { readonly kind: 'installed'; readonly file: string; readonly version: string }
  /** The project's `electron` package, its binary not downloaded yet. */
  | { readonly kind: 'undownloaded'; readonly package: ElectronPackage }
  | { readonly kind: 'misconfigured'; readonly problem: string };

function locateExecutable(projectRoot: string, executablePath: string | undefined, env: RunEnv, platform: NodeJS.Platform): Executable {
  if (executablePath !== undefined) {
    const resolved = path.resolve(projectRoot, executablePath);
    if (!isExecutableFile(resolved, platform)) {
      return { kind: 'misconfigured', problem: `electron({ executablePath }) names ${resolved}, which is not an executable file${executableHint(resolved, platform)}` };
    }
    const launched = platform === 'win32' ? squirrelApp(resolved) : undefined;
    if (launched !== undefined) {
      return { kind: 'misconfigured', problem: `electron({ executablePath }) names ${resolved}, the launcher its installer left there: it starts the app and exits, so name the app itself, ${launched}` };
    }
    return { kind: 'named', file: resolved };
  }
  const installed = electronPackage(projectRoot, env);
  if (installed === undefined) {
    return {
      kind: 'misconfigured',
      problem: `electron() starts the electron package installed in the project, and ${projectRoot} has none: install it (npm install --save-dev electron), or name an executable with electron({ executablePath })`,
    };
  }
  if (installed.binary !== undefined) return { kind: 'installed', file: installed.binary, version: installed.version };
  // The variable is wrong, and downloading would not help.
  if (installed.override !== undefined) {
    return { kind: 'misconfigured', problem: `ELECTRON_OVERRIDE_DIST_PATH names the directory of the Electron binary, and none is at ${installed.override}; fix the variable or unset it` };
  }
  return { kind: 'undownloaded', package: installed };
}

/** The executable a launch starts, checked: an `executablePath` that runs, or the project's downloaded Electron binary. */
export function resolveExecutable(projectRoot: string, executablePath: string | undefined, env: RunEnv, platform: NodeJS.Platform = process.platform): string {
  const found = locateExecutable(projectRoot, executablePath, env, platform);
  switch (found.kind) {
    case 'named':
    case 'installed':
      return found.file;
    case 'misconfigured':
      throw new ConfigurationError('INVALID_CONFIG', found.problem);
    case 'undownloaded':
      throw new InfrastructureError(
        'ELECTRON_INSTALL_FAILED',
        `electron ${found.package.version} is installed at ${found.package.directory} without its binary; the engine's prepare step downloads it before the first test`,
      );
  }
}

/**
 * Downloads the project's Electron binary when it is missing. Nothing to do
 * with `executablePath`, or with the binary in place; a wrong path fails
 * here, once for the run rather than once per test.
 */
export async function ensureElectronBinary(projectRoot: string, executablePath: string | undefined, env: RunEnv, log: (line: string) => void, signal: AbortSignal): Promise<void> {
  const found = locateExecutable(projectRoot, executablePath, env, process.platform);
  if (found.kind === 'misconfigured') throw new ConfigurationError('INVALID_CONFIG', found.problem);
  if (found.kind !== 'undownloaded') return;
  await download(found.package, env, log, signal);
  if (electronPackage(projectRoot, env)?.binary === undefined) {
    throw new InfrastructureError('ELECTRON_INSTALL_FAILED', `electron ${found.package.version}'s install.js finished, but its binary is still missing at ${found.package.directory}`);
  }
}

/** Runs the package's own `install.js` (what its first `require` would run), its output sent to `log`. */
async function download(installed: ElectronPackage, env: RunEnv, log: (line: string) => void, signal: AbortSignal): Promise<void> {
  const script = path.join(installed.directory, 'install.js');
  if (!existsSync(script)) {
    throw new InfrastructureError('ELECTRON_INSTALL_FAILED', `electron ${installed.version} at ${installed.directory} has no binary and no install.js to download it with; reinstall the electron package`);
  }
  log(`downloading the Electron ${installed.version} binary`);
  const failure = await new Promise<string | undefined>((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: installed.directory, env, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let tail = '';
    const read = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-INSTALL_OUTPUT_TAIL);
      for (const line of text.split(/\r?\n/)) if (line.trim() !== '') log(line.trim());
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (cause) => resolve(cause.message));
    child.on('close', (code) => resolve(code === 0 ? undefined : `install.js exited with ${code}: ${tail.trim()}`));
  });
  if (failure !== undefined) throw new InfrastructureError('ELECTRON_INSTALL_FAILED', `downloading the Electron ${installed.version} binary failed: ${failure}`);
}

/** For `e2e doctor`: what a run would start, without downloading anything. */
export function describeExecutable(projectRoot: string, executablePath: string | undefined, env: RunEnv, platform: NodeJS.Platform = process.platform): { readonly status: 'pass' | 'warn' | 'fail'; readonly message: string } {
  const found = locateExecutable(projectRoot, executablePath, env, platform);
  switch (found.kind) {
    case 'named':
      return { status: 'pass', message: `starts ${found.file}` };
    case 'installed':
      return { status: 'pass', message: `electron ${found.version} at ${found.file}` };
    case 'undownloaded':
      return { status: 'warn', message: `electron ${found.package.version} is installed without its binary; the first run downloads it` };
    case 'misconfigured':
      return { status: 'fail', message: found.problem };
  }
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
