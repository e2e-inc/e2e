/** Reading package.json and its scripts, for the framework modules. */

import type { FrameworkManifest } from '../frameworks.ts';

/** The script that starts a dev server. */
export const DEV_SCRIPT = 'dev';

/** Whether package.json lists `name` in `dependencies` or `devDependencies`. */
export function declares(manifest: FrameworkManifest, name: string): boolean {
  return manifest.dependencies?.[name] !== undefined || manifest.devDependencies?.[name] !== undefined;
}

/** Launchers whose quoted arguments are commands: `concurrently "vite" "tsc -w"`, `sh -c "vite"`. */
const RUNNERS = new Set(['concurrently', 'sh', 'bash']);

/** A script's commands, split at `&&`, `||`, `;`, `&`, and `|`, each as its words. */
export function commandsOf(script: string): string[][] {
  return script.split(/&&|\|\||[;&|]/u).map(words);
}

/** The words of one shell command, with the quotes around each stripped. */
function words(command: string): string[] {
  return command.split(/\s+/u).map((word) => word.replace(/^["']|["']$/gu, '')).filter((word) => word !== '');
}

/** A raw port value as a port: a number from 1 to 65535, else undefined (`$PORT`, `0`). */
export function fixedPort(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/**
 * A script's commands, each as its words from the binary on (see
 * `launched`). A script splits at `&&`, `||`, `;`, `&`, and `|`. Under one
 * of `RUNNERS`, a quoted argument is a command of its own
 * (`concurrently -k "vite" "json-server --port 3001"`); under any other
 * command it is one word, as in `vite "web"` or `echo "vite"`.
 */
export function launchedCommands(script: string): string[][] {
  const commands: string[][] = [];
  for (const part of script.split(/&&|\|\||[;&|]/u)) {
    const outer: string[] = [];
    for (const match of part.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/gu)) {
      const quoted = match[1] ?? match[2];
      if (quoted === undefined) outer.push(match[3] ?? '');
      else if (RUNNERS.has(launched(outer)[0] ?? '')) commands.push(launched(quoted.split(/\s+/u).filter((word) => word !== '')));
      else outer.push(quoted);
    }
    commands.push(launched(outer));
  }
  return commands.filter((command) => command.length > 0);
}

/** A command from its binary on: `npx vite`, `cross-env NODE_ENV=dev vite`, and `PORT=1 vite` are `vite`. */
function launched(command: string[]): string[] {
  let start = 0;
  for (;;) {
    const word = command[start];
    if (word === 'npx' || word === 'bunx' || word === 'yarn' || word === 'cross-env' || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word ?? '')) start += 1;
    else if ((word === 'pnpm' || word === 'npm') && command[start + 1] === 'exec') start += 2;
    else return command.slice(start);
  }
}
