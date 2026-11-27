/**
 * The bound on local files: an Electron app loads its own `file:` pages, and
 * a link or a script in one can take a window to any file the user can read.
 * A window that left the app's own directory is not observed, traced, or
 * captured.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** What is known of where the app's files are. */
export interface AppFiles {
  /** `app.getAppPath()`, when the main process answered: the app's directory, or its `.asar` archive. */
  readonly reported: string | undefined;
  /** The target's `app.appPath`, resolved: a directory or the main script. */
  readonly declared: string | undefined;
  /** The first document the app showed. */
  readonly firstDocument: string;
}

/**
 * The directory the app's own pages are in, or undefined when nothing says:
 * for a declared main script, the package it belongs to; else what the main
 * process reports, else the declared app path, else the archive or directory
 * of the first local page the app showed.
 */
export function appDirectory({ reported, declared, firstDocument }: AppFiles): string | undefined {
  // Electron reports a main script's own directory, and a build can put the pages beside it (`out/main/index.js`
  // and `out/renderer/`): the app is the package the script is in, as it is for an app path that names the directory.
  if (declared !== undefined && statSync(declared, { throwIfNoEntry: false })?.isFile() === true) return canonical(packageOf(declared) ?? path.dirname(declared));
  if (reported !== undefined && reported !== '') return canonical(reported);
  if (declared !== undefined) return canonical(statSync(declared, { throwIfNoEntry: false })?.isDirectory() === true ? declared : path.dirname(declared));
  const file = localFile(firstDocument);
  if (file === undefined) return undefined;
  const archive = /^(.*?\.asar)(?:[\\/]|$)/.exec(file)?.[1];
  return canonical(archive ?? path.dirname(file));
}

/**
 * Why a window at `location` is not one to observe or capture, or undefined
 * when it is: a `file:` location outside the app's directory. With no
 * directory known, every `file:` location is outside: the rule fails closed.
 * Any other location passes.
 */
export function outsideApp(location: string, directory: string | undefined): string | undefined {
  if (!URL.canParse(location) || new URL(location).protocol !== 'file:') return undefined;
  const file = localFile(location);
  const shown = `file://${new URL(location).pathname}`;
  if (file === undefined || directory === undefined) return `the window shows a local file, ${shown}, and the app's own directory is not known, so it is not read`;
  const relative = path.relative(directory, canonical(file));
  const inside = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return inside ? undefined : `the window left the app's directory for ${shown}, a local file outside it, so it is not read`;
}

/**
 * The nearest directory above `file` with a `package.json` that names a
 * package, or undefined when none has one. A manifest that only sets the
 * module type (`{"type":"commonjs"}`, which build tools write into their
 * output) marks how Node loads the files there, not a package of its own.
 */
function packageOf(file: string): string | undefined {
  for (let directory = path.dirname(path.resolve(file)); ; directory = path.dirname(directory)) {
    const manifest = path.join(directory, 'package.json');
    if (existsSync(manifest) && !onlyModuleType(manifest)) return directory;
    if (path.dirname(directory) === directory) return undefined;
  }
}

function onlyModuleType(manifest: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).join() === 'type';
  } catch {
    // A manifest that cannot be read is no proof the package is elsewhere: the nearer directory is the narrower bound.
    return false;
  }
}

function localFile(location: string): string | undefined {
  try {
    return fileURLToPath(location);
  } catch {
    return undefined;
  }
}

/** A path with its links resolved, as far as it exists: a page inside an `.asar` archive is no file on disk. */
function canonical(file: string): string {
  const rest: string[] = [];
  let at = path.resolve(file);
  for (;;) {
    try {
      return path.join(realpathSync(at), ...rest);
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return path.resolve(file);
      rest.unshift(path.basename(at));
      at = parent;
    }
  }
}
