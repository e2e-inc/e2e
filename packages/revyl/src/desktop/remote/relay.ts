/**
 * The relay on the Revyl Mac, between the runner and the engine servers.
 * Revyl's API reaches a computer only through short execs that run one at a
 * time, with no stream into a running process and no port, so the engine
 * servers live under a LaunchAgent (`serve`), in the desktop session where
 * they hold Accessibility and Screen Recording, and each exec the runner
 * sends runs `exchange`: it hands the relay the protocol bytes the runner
 * wrote, waits for the servers' answers, and prints them.
 *
 * Copied to the Mac with `server.ts`, `frames.ts`, and `wire.ts`; imports nothing but Node.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequest, type ExchangeAnswer, type ExchangeRequest, type SessionExit } from './wire.ts';

interface Session {
  readonly child: ChildProcess;
  chunks: Buffer[];
  stderr: string;
  exit: Omit<SessionExit, 'stderr'> | undefined;
}

const STDERR_TAIL = 4096;
const CLOSE_GRACE_MS = 5000;
/** How long the relay keeps gathering once the first output arrived, so a reply and the notes after it travel together. */
const COALESCE_MS = 25;

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, `server${path.extname(fileURLToPath(import.meta.url))}`);

function serve(socket: string): void {
  const sessions = new Map<string, Session>();
  let wake: (() => void) | undefined;

  const start = (id: string, env: Readonly<Record<string, string>>): void => {
    const child = spawn(process.execPath, [SERVER], { cwd: here, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const session: Session = { child, chunks: [], stderr: '', exit: undefined };
    sessions.set(id, session);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => {
      session.chunks.push(chunk);
      wake?.();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      session.stderr = (session.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.on('error', (cause) => {
      session.stderr += `\n${cause.message}`;
    });
    child.on('close', (code, signal) => {
      session.exit = { code, signal };
      wake?.();
    });
  };

  const answer = (request: ExchangeRequest, budget: number): ExchangeAnswer => {
    const output: Record<string, string> = {};
    const exited: Record<string, SessionExit> = {};
    let left = budget;
    for (const id of request.sessions) {
      const session = sessions.get(id);
      if (session === undefined) {
        exited[id] = { code: null, signal: null, stderr: 'the relay on the Mac has no such session: it restarted, which ends every server it ran' };
        continue;
      }
      const all = Buffer.concat(session.chunks);
      const taken = all.subarray(0, Math.max(0, left));
      session.chunks = taken.length < all.length ? [all.subarray(taken.length)] : [];
      left -= taken.length;
      if (taken.length > 0) output[id] = taken.toString('base64');
      if (session.exit !== undefined && session.chunks.length === 0) {
        exited[id] = { ...session.exit, stderr: session.stderr.trim() };
        sessions.delete(id);
      }
    }
    return { output, exited, more: request.sessions.some((id) => (sessions.get(id)?.chunks.length ?? 0) > 0) };
  };

  rmSync(socket, { force: true });
  createServer((connection) => {
    let line = '';
    connection.setEncoding('utf8');
    connection.on('error', () => {});
    connection.on('data', async (chunk: string) => {
      line += chunk;
      if (!line.endsWith('\n')) return;
      const request = parseRequest(line);
      for (const { id, env } of request.open ?? []) start(id, env);
      for (const [id, bytes] of Object.entries(request.input ?? {})) sessions.get(id)?.child.stdin?.write(Buffer.from(bytes, 'base64'));
      for (const id of request.close ?? []) {
        const child = sessions.get(id)?.child;
        child?.stdin?.end();
        setTimeout(() => child?.kill('SIGKILL'), CLOSE_GRACE_MS).unref();
      }
      const ready = (): boolean => request.sessions.some((id) => { const session = sessions.get(id); return session === undefined || session.chunks.length > 0 || session.exit !== undefined; });
      if (!ready() && request.wait > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, request.wait);
          wake = () => {
            if (!ready()) return;
            clearTimeout(timer);
            setTimeout(resolve, COALESCE_MS);
          };
        });
        wake = undefined;
      }
      connection.end(`${JSON.stringify(answer(request, request.budget))}\n`);
    });
  }).listen(socket);
}

/** One exec: the request on stdin to the relay, its answer to stdout. Exits 3 when the relay is not running. */
async function exchange(socket: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const connection = createConnection(socket);
  connection.on('error', (cause) => {
    process.stderr.write(`the relay on the Mac is not running: ${cause.message}\n`);
    process.exit(3);
  });
  connection.write(Buffer.concat([...chunks, Buffer.from('\n')]));
  connection.pipe(process.stdout);
}

const [mode, socket] = process.argv.slice(2);
if (socket === undefined) throw new Error('usage: relay serve|exchange <socket>');
if (mode === 'serve') serve(socket);
else if (mode === 'exchange') await exchange(socket);
else throw new Error(`unknown mode ${String(mode)}`);
