/**
 * The driver's end of the `chromium-bidi` mapper process
 * (`mapper-process.ts`): spawns it, names its CDP target, and carries BiDi
 * over its stdio.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { raceAbort, withTimeout } from '@e2e-dev/core/engine';
import type { BidiTransport } from './connection.ts';
import { MAPPER_READY, type MapperTarget } from './mapper-process.ts';

/** The mapper's entry point beside this module: the built `.js`, or the source when run from `src`. */
const MAPPER_ENTRY = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './mapper-process.ts' : './mapper-process.js', import.meta.url));

/**
 * Starts the `chromium-bidi` mapper in a child process at once, so it loads
 * while the browser starts, hands it the target `cdp` resolves to, and
 * returns the BiDi side of it, one JSON message per stdio line. Resolves
 * once the mapper serves; `signal` aborting first kills it.
 */
export async function chromiumMapper(cdp: Promise<MapperTarget>, timeoutMs: number, signal: AbortSignal): Promise<BidiTransport> {
  const child = spawn(process.execPath, [MAPPER_ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => {
    errors = `${errors}${chunk.toString()}`.slice(-4_000);
  });
  child.stdin.on('error', () => undefined);
  const exited = new Promise<string>((resolve) => {
    child.once('error', (cause) => resolve(`the chromium-bidi mapper could not start: ${cause.message}`));
    child.once('exit', (code, killedBy) => resolve(`the chromium-bidi mapper exited (${killedBy ?? `code ${String(code)}`})${errors.trim() === '' ? '' : `: ${errors.trim()}`}`));
  });
  let deliver: (message: string) => void = () => undefined;
  let ready: () => void = () => undefined;
  const started = new Promise<void>((resolve) => (ready = resolve));
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line === MAPPER_READY) ready();
    else deliver(line);
  });
  try {
    const target = await raceAbort(Promise.race([cdp, exited.then((reason) => Promise.reject(new Error(reason)))]), signal, 'starting the chromium-bidi mapper');
    child.stdin.write(`${JSON.stringify(target)}\n`);
    await withTimeout(
      raceAbort(Promise.race([started, exited.then((reason) => Promise.reject(new Error(reason)))]), signal, 'starting the chromium-bidi mapper'),
      timeoutMs,
      () => new Error(`the chromium-bidi mapper did not start within ${timeoutMs}ms`),
    );
  } catch (cause) {
    child.kill('SIGKILL');
    throw cause;
  }
  return {
    send: (message) => {
      if (!child.stdin.writable) throw new Error('the chromium-bidi mapper is gone');
      child.stdin.write(`${message}\n`);
    },
    onMessage: (handler) => {
      deliver = handler;
    },
    onClose: (handler) => void exited.then(handler),
    close: () => {
      child.stdin.end();
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    },
  };
}
