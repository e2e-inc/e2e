/**
 * `revylDesktop()` against a scripted Revyl API and a scripted relay on the
 * Mac: the options it refuses, the computer it creates, starts, or uses as
 * it is, the setup it sends, the protocol bytes it carries through execs,
 * and the computer it stops on every path. The relay and the server on the
 * Mac run only on a real computer, in the integration guide's proof.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TransportConnection, TransportContext } from 'e2e/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revylDesktop, type RevylDesktopOptions } from '../../src/desktop.ts';
import { frame, FrameReader, type Message } from '../../src/desktop/remote/frames.ts';
import type { ExchangeAnswer, ExchangeRequest } from '../../src/desktop/remote/wire.ts';
import { computerTransport, type ComputerOptions } from '../../src/desktop/transport.ts';

const env = { REVYL_API_KEY: 'revyl-key' };
const COMPUTER = '7f78ec98-6f80-42b7-893f-52125f4a0fce';
const PACKAGES = ['@e2e-dev/desktop@1.2.3', '@e2e-dev/core@4.5.6'];

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
}

/** A command the scripted Mac ran: its argv and stdin decoded, or the file it wrote. */
interface Ran {
  readonly argv?: string[];
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly file?: string;
}

let calls: Call[];
let ran: Ran[];
/** The state each `GET /computer-runs/{id}` reads, in turn; the last one repeats. */
let states: string[];
/** Answers an exchange as the relay on the Mac would. */
let relay: (request: ExchangeRequest) => ExchangeAnswer;

const decode = (value: string): string => Buffer.from(value, 'base64').toString('utf8');
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const executed = (stdout: string, exitCode = 0): Response =>
  json({ operation_id: randomUUID(), evidence: 'recorded', execution: { outcome: exitCode === 0 ? 'succeeded' : 'failed', ...(exitCode === 0 ? {} : { error_code: 'exec_nonzero' }), result: { kind: 'exec', exit_code: exitCode, stdout: Buffer.from(stdout).toString('base64'), stderr: Buffer.from(exitCode === 0 ? '' : 'npm ERR! 404').toString('base64') } } });

/** The ledger directory of this process's computers. */
const ledger = (): string => path.join(tmpdir(), 'e2e-revyl', `mac-${process.pid}`);
const markers = (): string[] => (existsSync(ledger()) ? readdirSync(ledger(), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name) : []);
const paths = (): string[] => calls.filter((call) => !call.path.endsWith('/operations')).map((call) => `${call.method} ${call.path}`);
const exchanges = (): ExchangeRequest[] => ran.filter((command) => command.argv?.[2] === 'exchange').map((command) => JSON.parse(command.stdin!) as ExchangeRequest);

beforeEach(() => {
  calls = [];
  ran = [];
  states = ['starting', 'active'];
  relay = (request) => ({ output: {}, exited: {}, more: false, ...(request.close?.length ? { exited: Object.fromEntries(request.close.map((id) => [id, { code: 0, signal: null, stderr: '' }])) } : {}) });
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const body = init.body === undefined ? undefined : (JSON.parse(init.body as string) as Record<string, unknown>);
    calls.push({ method: init.method ?? 'GET', path: url.pathname, body });
    const route = `${init.method ?? 'GET'} ${url.pathname}`;
    if (route === 'POST /api/v1/computer-runs') return json({ computer_session_id: body!.computer_session_id, state: 'starting' });
    if (/^GET \/api\/v1\/computer-runs\/[^/]+$/.test(route)) return json({ state: states.length > 1 ? states.shift() : states[0] });
    if (/\/(start|stop)$/.test(route)) return json({});
    if (route.endsWith('/operations')) {
      const command = body!.command as Record<string, unknown>;
      if (command.kind === 'file_write') {
        ran.push({ file: decode(command.path_b64 as string) });
        return json({ evidence: 'recorded', execution: { outcome: 'succeeded', result: { kind: 'file_write', byte_count: 1 } } });
      }
      const argv = (command.argv_b64 as string[]).map(decode);
      const stdin = command.stdin === undefined ? undefined : decode(command.stdin as string);
      const commandEnv = command.env_b64 === undefined ? undefined : Object.fromEntries(Object.entries(command.env_b64 as Record<string, string>).map(([name, value]) => [name, decode(value)]));
      ran.push({ argv, ...(stdin === undefined ? {} : { stdin }), ...(commandEnv === undefined ? {} : { env: commandEnv }) });
      if (argv[2] === 'exchange') return executed(JSON.stringify(relay(JSON.parse(stdin!) as ExchangeRequest)));
      return executed('');
    }
    throw new Error(`unscripted ${route}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(ledger(), { recursive: true, force: true });
});

function context(overrides: Partial<TransportContext> = {}): TransportContext {
  return { role: 'run', env, cwd: process.cwd(), signal: new AbortController().signal, app: { bundleId: 'com.apple.calculator' }, ...overrides } as TransportContext;
}

const transport = (options: Partial<ComputerOptions> = {}) => computerTransport({ computer: undefined, lifetimeSeconds: 3600, packages: PACKAGES, ...options });

/** Reads frames off a connection's input until `count` arrived. */
async function read(connection: TransportConnection, count: number): Promise<Message[]> {
  const reader = new FrameReader();
  const messages: Message[] = [];
  for await (const chunk of connection.input) {
    messages.push(...reader.push(chunk as Buffer).flatMap(({ message }) => (message === undefined ? [] : [message])));
    if (messages.length >= count) return messages;
  }
  return messages;
}

describe('revylDesktop()', () => {
  it.each<[string, unknown]>([
    ['a computer id that is not a UUID', { computer: 'my-mac' }],
    ['a lifetime under five minutes', { lifetimeSeconds: 60 }],
    ['a fractional lifetime', { lifetimeSeconds: 600.5 }],
    ['a lifetime over a day', { lifetimeSeconds: 90_000 }],
    ["a desktop option the engine refuses", { maxDepth: 0 }],
    ['an unknown option', { headless: true }],
  ])('refuses %s with INVALID_CONFIG', (_, given) => {
    expect(() => revylDesktop(given as RevylDesktopOptions)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('takes a blank computer id, as an unset variable reads, for none', () => {
    expect(() => revylDesktop({ computer: ' ' })).not.toThrow();
  });

  it('describes the desktop engine it serves, one worker on macOS', () => {
    const engine = revylDesktop({ snapshot: 'interactive' });

    expect(engine.name).toBe('desktop');
    expect(engine.platform).toBe('macos');
    expect(engine.workers).toBe(1);
  });
});

describe('the Revyl computer transport', () => {
  it('creates a Mac that Revyl deletes when it stops, sets it up, and stops it when the run connection closes', async () => {
    const connection = await transport().open(context());
    const created = calls[0]!.body!;

    expect(created).toEqual({ computer_session_id: expect.any(String), os: 'macos', persistent: false, timeout_seconds: 3600 });
    expect(markers()).toEqual([created.computer_session_id]);
    const setup = ran.find((command) => command.env?.PACKAGES !== undefined)!;
    expect(setup.env).toMatchObject({ PACKAGES: '@e2e-dev/desktop@1.2.3 @e2e-dev/core@4.5.6', APP_SHA: '' });
    expect(ran.filter((command) => command.file !== undefined).map((command) => path.basename(command.file!))).toEqual(['frames.ts', 'relay.ts', 'server.ts', 'wire.ts']);

    await connection.close(1000);

    expect(paths().at(-1)).toBe(`POST /api/v1/computer-runs/${String(created.computer_session_id)}/stop`);
    expect(markers()).toEqual([]);
    expect(exchanges()[0]!.open).toEqual([{ id: expect.any(String), env: { E2E_REVYL_COMPUTER: created.computer_session_id } }]);
  });

  it('uses a persistent computer that runs as it is, and leaves it running', async () => {
    states = ['active'];
    const connection = await transport({ computer: COMPUTER }).open(context());
    await connection.close(1000);

    expect(paths().filter((call) => call.startsWith('POST'))).toEqual([]);
    expect(markers()).toEqual([]);
  });

  it('starts a stopped persistent computer for the run and stops it again after', async () => {
    states = ['stopped', 'starting', 'active'];
    const connection = await transport({ computer: COMPUTER, lifetimeSeconds: 900 }).open(context());

    expect(calls.find((call) => call.path.endsWith('/start'))!.body).toEqual({ timeout_seconds: 900 });
    expect(markers()).toEqual([COMPUTER]);

    await connection.close(1000);

    expect(paths().at(-1)).toBe(`POST /api/v1/computer-runs/${COMPUTER}/stop`);
    expect(markers()).toEqual([]);
  });

  it('stops the computer it created when setting it up fails, and names why', async () => {
    const scripted = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      const command = init.body === undefined ? undefined : (JSON.parse(init.body as string) as { command?: { env_b64?: Record<string, string> } }).command;
      if (command?.env_b64?.PACKAGES !== undefined) {
        calls.push({ method: 'POST', path: new URL(input).pathname, body: undefined });
        return executed('', 1);
      }
      return scripted(input as never, init);
    });

    await expect(transport().open(context())).rejects.toThrow('npm ERR! 404');
    expect(paths().at(-1)).toMatch(/\/stop$/);
    expect(markers()).toEqual([]);
  });

  it('fails a computer that stopped before it ran, with the state Revyl reports', async () => {
    states = ['starting', 'failed'];

    await expect(transport().open(context())).rejects.toThrow(/is failed/);
    expect(paths().at(-1)).toMatch(/\/stop$/);
  });

  it("reaches the run's computer from a worker through the variables prepare handed it, and creates none", async () => {
    const connection = await transport().open(context({ role: 'worker', env: { ...env, E2E_REVYL_COMPUTER: COMPUTER, E2E_REVYL_APP: '/Users/computer/workspace/.e2e-revyl/apps/abc/My.app' } }));
    await connection.close(1000);

    expect(calls.every((call) => call.path === `/api/v1/computer-runs/${COMPUTER}/operations`)).toBe(true);
    expect(exchanges()[0]!.open![0]!.env).toEqual({ E2E_REVYL_COMPUTER: COMPUTER, E2E_REVYL_APP: '/Users/computer/workspace/.e2e-revyl/apps/abc/My.app' });
  });

  it('refuses a worker that prepare handed no computer', async () => {
    await expect(transport().open(context({ role: 'worker' }))).rejects.toThrow('E2E_REVYL_COMPUTER');
    expect(calls).toEqual([]);
  });

  it("carries a request to the server and its answer back, waiting on the Mac only while an answer is owed", async () => {
    states = ['active'];
    relay = (request) => {
      const output: Record<string, string> = {};
      for (const [id, bytes] of Object.entries(request.input ?? {})) {
        const asked = new FrameReader().push(Buffer.from(bytes, 'base64'));
        output[id] = Buffer.concat(asked.map(({ message }) => frame({ id: message!.id!, result: { echoed: message!.method } }))).toString('base64');
      }
      return { output, exited: {}, more: false };
    };
    const connection = await transport({ computer: COMPUTER }).open(context({ role: 'worker', env: { ...env, E2E_REVYL_COMPUTER: COMPUTER } }));
    const answers = read(connection, 1);
    connection.output.write(frame({ id: 1, method: 'engine/observe', params: {} }));

    expect(await answers).toEqual([{ id: 1, result: { echoed: 'engine/observe' } }]);
    const sent = exchanges().find((request) => request.input !== undefined && Object.keys(request.input).length > 0)!;
    expect(sent.wait).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThan(16_384);
  });

  it('splits a large message across execs under the stdin bound, in order', async () => {
    states = ['active'];
    const received: Buffer[] = [];
    relay = (request) => {
      for (const bytes of Object.values(request.input ?? {})) received.push(Buffer.from(bytes, 'base64'));
      return { output: {}, exited: {}, more: false };
    };
    const connection = await transport().open(context({ role: 'worker', env: { ...env, E2E_REVYL_COMPUTER: COMPUTER } }));
    const message = frame({ method: 'keyboard/type', params: { text: 'x'.repeat(40_000) } });
    connection.output.write(message);
    await vi.waitFor(() => expect(Buffer.concat(received)).toEqual(message));

    expect(received.length).toBeGreaterThan(1);
    expect(exchanges().every((request) => Buffer.byteLength(JSON.stringify(request)) < 16_384)).toBe(true);
  });

  it("ends a connection whose server exited, with the server's stderr for the error", async () => {
    states = ['active'];
    relay = (request) => ({ output: {}, exited: Object.fromEntries(request.sessions.map((id) => [id, { code: 1, signal: null, stderr: 'Cannot find module @e2e-dev/desktop' }])), more: false });
    const connection = await transport().open(context({ role: 'worker', env: { ...env, E2E_REVYL_COMPUTER: COMPUTER } }));
    connection.output.write(frame({ id: 1, method: 'initialize', params: {} }));

    expect(await read(connection, 1)).toEqual([]);
    expect(connection.diagnostics?.()).toBe('exited with code 1; stderr:\nCannot find module @e2e-dev/desktop');
  });
});

describe('FrameReader', () => {
  it('reads messages cut anywhere between chunks', () => {
    const bytes = Buffer.concat([frame({ id: 1, method: 'a' }), frame({ id: 2, result: 'é' })]);
    const reader = new FrameReader();
    const messages = [...bytes].flatMap((byte) => reader.push(Buffer.from([byte])).map(({ message }) => message));

    expect(messages).toEqual([{ id: 1, method: 'a' }, { id: 2, result: 'é' }]);
  });
});
