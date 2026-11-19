/**
 * The process a launched browser lives under, which ties its lifetime to the
 * worker that launched it. The worker spawns this with a stdin pipe
 * (`spawnWatched`); this spawns the browser in a process group of its own
 * and passes its stderr through for the endpoint line. When stdin closes,
 * because the worker closed the browser (`stopped`), exited, or was killed
 * (even with SIGKILL, which runs no exit hook), the browser's whole group is
 * killed, its helper processes with it (its process tree on Windows).
 * Whichever way the browser exits, its profile directory is removed before
 * this exits.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { rmSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A watchdog as the worker holds it: its stdin keeps the browser alive, and its stderr is the browser's. */
export type Watchdog = ChildProcessByStdio<Writable, null, Readable>;

/** How long the watchdog gets to kill the browser and remove its profile. */
const WATCHDOG_EXIT_MS = 10_000;

/**
 * Spawns `executable` under a watchdog, which holds this process's end of a
 * stdin pipe: the browser's stderr comes through the watchdog's, and the
 * browser and `profile` go once this process closes the pipe or exits.
 */
export function spawnWatched(profile: string, executable: string, args: readonly string[]): Watchdog {
  const watchdog = spawn(process.execPath, [fileURLToPath(import.meta.url), profile, executable, ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
  watchdog.stdin.on('error', () => undefined);
  return watchdog;
}

/** Resolves with the endpoint `watchdog`'s browser prints on stderr once it listens. */
export function endpointLine(watchdog: Watchdog, pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`no endpoint within ${timeoutMs}ms`)), timeoutMs);
    watchdog.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = pattern.exec(output);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      // Drained so a chatty browser never blocks on a full pipe.
      watchdog.stderr.removeAllListeners('data');
      watchdog.stderr.resume();
      resolve(match[1]);
    });
    watchdog.once('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    watchdog.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`browser exited with code ${String(code)} before listening: ${output.slice(-500)}`));
    });
  });
}

/**
 * Closes the watchdog's stdin, which kills the browser and removes its
 * profile, and resolves once the watchdog exited; a watchdog that outlives
 * its grace is killed.
 */
export function stopped(watchdog: Watchdog): Promise<void> {
  if (watchdog.exitCode !== null || watchdog.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      watchdog.kill('SIGKILL');
      resolve();
    }, WATCHDOG_EXIT_MS);
    watchdog.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    watchdog.stdin.end();
  });
}

/** Runs the browser `argv` names until it exits or stdin closes, then removes its profile and exits with its code. */
function watch(argv: readonly string[]): void {
  const [profile, executable, ...args] = argv;
  if (profile === undefined || executable === undefined) {
    process.stderr.write('browser watchdog: expected a profile directory and an executable\n');
    process.exit(2);
  }
  // Windows has no process groups; there `taskkill /T` ends the browser's process tree.
  const grouped = process.platform !== 'win32';
  const browser = spawn(executable, args, { stdio: ['ignore', 'ignore', 'inherit'], detached: grouped });
  const kill = (): void => {
    if (browser.pid === undefined) return;
    try {
      if (grouped) process.kill(-browser.pid, 'SIGKILL');
      else spawnSync('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // The group is already gone.
    }
  };
  const finish = (code: number): never => {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    process.exit(code);
  };
  browser.once('error', (cause) => {
    process.stderr.write(`browser watchdog: could not start ${executable}: ${cause.message}\n`);
    finish(1);
  });
  browser.once('exit', (code) => {
    kill();
    finish(code ?? 1);
  });
  process.stdin.once('close', kill);
  process.stdin.once('end', kill);
  process.stdin.on('error', kill);
  process.stdin.resume();
  process.on('SIGTERM', kill);
  // The browser has its own group, so a terminal interrupt does not reach it: pass it on, and stay to remove the profile.
  process.on('SIGINT', kill);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) watch(process.argv.slice(2));
