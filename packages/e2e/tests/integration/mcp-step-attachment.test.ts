/** Exercises held test attachments through the built CLI and MCP server. */

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Report1Document } from '../../src/report/build.ts';
import { AttachHello, AttachRequest, type AttachReply } from '../../src/run/step-attachment-wire.ts';
import { parseLine, readSocketLines, stepAddress } from '../../src/run/step-socket.ts';
import { contentsUnder, createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const ENV = { ...process.env, CI: '', NO_COLOR: '1' };
const STEP = 'await app.open("/after");';
const PASSWORD = 'fixture-password';
const CONFIG = `import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

let appLog;
const { engine } = createFakeEngine({
  video: true,
  onStartAttempt(context) {
    appLog = context.appLog;
  },
  onNavigate(url) {
    appLog({ level: 'warning', source: 'console', text: 'App log for ' + new URL(url).pathname });
  },
  scene: () => [
    {
      id: 'submit', role: 'button', name: 'Submit',
      on(action, node) {
        if (action.kind === 'tap') {
          node.name = 'Submitted';
        }
      },
    },
    { id: 'receipt', role: 'status', text: 'Receipt ${PASSWORD}' },
  ],
});

export default {
  targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }],
  secrets: { password: '${PASSWORD}' },
  workers: 1,
};
`;

const projects: FixtureProject[] = [];
const runs: ReturnType<typeof spawn>[] = [];
const clients: Client[] = [];

/** Writes a test that opens its app before the given statements run. */
function project(body: string, config = CONFIG): string {
  const created = createProject({
    'e2e.config.ts': config,
    'tests/checkout.e2e.ts': `import { test } from 'e2e';

test('completes checkout', async ({ app, screen }) => {
  await app.open('/checkout');
  ${body}
});
`,
  });
  projects.push(created);
  return created.dir;
}

/** Runs one step command from the project directory. */
function e2e(dir: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: ENV,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

/** Reads the pause ID from the header. */
function printedId(text: string): string {
  const id = /^Paused \((p\d+)\) /m.exec(text)?.[1];

  if (id === undefined) {
    throw new Error(`no attachment id in output:\n${text}`);
  }

  return id;
}

/** Runs until the first explicit pause. */
async function pause(dir: string, ...flags: string[]) {
  const child = spawn(process.execPath, [CLI, 'run', ...flags], {
    cwd: dir,
    env: ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runs.push(child);
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
  }
  await vi.waitFor(() => expect(output).toContain('Next: e2e run --step next'), { timeout: 25_000 });
  return { id: printedId(output), exited };
}

/** Opens an MCP client in the run directory with the same temp directory settings. */
async function mcp(dir: string) {
  const temp = Object.fromEntries(['TMPDIR', 'TEMP', 'TMP'].flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: dir,
    stderr: 'ignore',
    env: { ...temp, E2E_TELEMETRY_DISABLED: '1', E2E_UPDATE_CHECK_DISABLED: '1' },
  });
  const client = new Client({ name: 'step-attachment-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(transport);
  return { client, transport };
}

/** Invokes a tool and collects its text, including any error reason. */
async function invoke(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, { timeout: 25_000 });

  return {
    text: result.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n'),
    isError: result.isError === true,
  };
}

/** Attaches to the paused test and reads the session ID from the reply. */
async function attach(client: Client, id: string) {
  const reply = await invoke(client, 'open_session', { attach: id });
  expect(reply.isError, reply.text).toBe(false);
  const session = /^Session (\S+) open on target/.exec(reply.text)?.[1];

  if (session === undefined) {
    throw new Error(`no session id in opening:\n${reply.text}`);
  }

  return { session, text: reply.text };
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  try {
    for (const created of projects) e2e(created.dir, 'run', '--step', 'stop');
  } finally {
    for (const run of runs.splice(0)) run.kill();
    for (const created of projects.splice(0)) created.cleanup();
  }
});

describe('MCP attachments to held tests', { timeout: 60_000 }, () => {
  it("reads and drives the paused test's app", async () => {
    const dir = project(`await screen.pause(); ${STEP}`);
    const held = await pause(dir);
    const { client } = await mcp(dir);
    const opened = await attach(client, held.id);
    expect(opened.text).toContain('Current screen');
    expect(opened.text).toContain('button "Submit"');

    const detail = await invoke(client, 'tools', { session: opened.session, tool: 'tap' });
    expect(detail.text).toContain('Arguments (JSON Schema)');
    const located = await invoke(client, 'call', { tool: 'locate', args: { role: 'button', name: 'Submit' } });
    expect(located.text).toContain('1 node matches');
    const observed = await invoke(client, 'call', { tool: 'observe' });
    const target = /^[ \t]*#(\S+) button "Submit"/m.exec(observed.text)?.[1];

    if (target === undefined) {
      throw new Error(observed.text);
    }

    const tapped = await invoke(client, 'call', { tool: 'tap', args: { target } });
    expect(tapped.isError, tapped.text).toBe(false);
    expect(tapped.text).toContain('Submitted');
    expect((await invoke(client, 'call', { tool: 'test_lines' })).text).toContain('.tap()');
    expect(e2e(dir, 'run', '--step', 'next').status).toBe(0);
    expect(await held.exited).toBe(0);
  });

  it('redacts a displayed secret from the opening screen, tool results, and errors', async () => {
    const dir = project('await screen.pause();');
    const held = await pause(dir);
    const { client } = await mcp(dir);
    const opened = await attach(client, held.id);
    const observed = await invoke(client, 'call', { tool: 'observe' });
    const located = await invoke(client, 'call', { tool: 'locate', args: { role: 'status' } });
    const failed = await invoke(client, 'call', { tool: PASSWORD });

    expect(observed.isError).toBe(false);
    expect(located.isError).toBe(false);
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('UNKNOWN_TOOL');
    for (const text of [opened.text, observed.text, located.text, failed.text]) {
      expect(text).toContain('<secret:password>');
      expect(text).not.toContain(PASSWORD);
    }
  });

  it('attaches at a stepped hold and prints the same id in the next pause header', async () => {
    const dir = project(`await app.open("/review"); ${STEP}`);
    const first = e2e(dir, 'run', '--step');
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('Paused (p1) before step 2');
    const { client } = await mcp(dir);
    const id = printedId(first.stdout);
    const opened = await attach(client, id);

    const next = e2e(dir, 'run', '--step', 'next');
    expect(next.status).toBe(0);
    expect(next.stdout).toContain('Paused (p1) before step 3');
    expect(printedId(next.stdout)).toBe(id);
    await vi.waitFor(async () => {
      const later = await invoke(client, 'call', { session: opened.session, tool: 'observe' });
      expect(later.isError).toBe(true);
      expect(later.text).toContain('the test resumed');
    });
    expect(e2e(dir, 'run', '--step', 'rest').status).toBe(0);
  });

  it('lists held tests and their ids when an attachment id is unknown', async () => {
    const dir = project('await screen.pause();');
    const held = await pause(dir);
    const { client } = await mcp(dir);
    const reply = await invoke(client, 'open_session', { attach: 'p999' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('Held tests:');
    expect(reply.text).toContain(`${held.id}  completes checkout [fake]`);
  });

  it('explains how to hold a test when no run listens in this directory', async () => {
    const dir = project(STEP);
    const { client } = await mcp(dir);
    const reply = await invoke(client, 'open_session', { attach: 'p1' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('No test in this directory is held');
    expect(reply.text).toContain('screen.pause()');
    expect(reply.text).toContain('e2e run <files> --step');
  });

  it('names each argument that cannot be combined with attach', async () => {
    const { client } = await mcp(project(STEP));
    const excluded = {
      target: 'fake',
      config: 'e2e.config.ts',
      test: 'checkout',
      engine: '@e2e-dev/web',
      app: {},
      headed: false,
    };

    for (const [field, value] of Object.entries(excluded)) {
      const reply = await invoke(client, 'open_session', { attach: 'p1', [field]: value });
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain(`INVALID_ARGUMENT: open_session: attach cannot be combined with ${field}`);
    }
  });

  it('leaves the test held and attachable again after close_session', async () => {
    const dir = project(`await screen.pause(); ${STEP}`);
    const held = await pause(dir);
    const { client } = await mcp(dir);
    const first = await attach(client, held.id);
    expect((await invoke(client, 'close_session', { session: first.session })).isError).toBe(false);
    const second = await attach(client, held.id);
    expect(second.session).not.toBe(first.session);
    expect(second.text).toContain('path /checkout');
  });

  it('closes the MCP session when the test resumes before detach is acknowledged', async () => {
    const dir = project(STEP);
    let peer: net.Socket | undefined;
    // Reply to detach with ended so the test controls which frame arrives first.
    const server = net.createServer((socket) => {
      peer = socket;
      readSocketLines(socket, (line) => {
        const hello = parseLine(line, AttachHello);

        if (hello !== undefined) {
          socket.write(`${JSON.stringify(hello)}\n`);
          return true;
        }

        switch (parseLine(line, AttachRequest)?.type) {
          case 'attach': {
            const reply: AttachReply = {
              type: 'opening',
              opening: { target: 'fake', summary: '', catalog: [], observation: '' },
            };
            socket.write(`${JSON.stringify(reply)}\n`);
            return true;
          }

          case 'detach': {
            const reply: AttachReply = { type: 'ended', reason: 'the test resumed' };
            socket.end(`${JSON.stringify(reply)}\n`);
            return false;
          }

          default:
            socket.destroy();
            return false;
        }
      });
    });

    try {
      const listening = once(server, 'listening');
      server.listen(stepAddress(dir).socket);
      await listening;

      const { client } = await mcp(dir);
      const { session } = await attach(client, 'p1');
      const closed = await invoke(client, 'close_session', { session });
      expect(closed.isError, closed.text).toBe(false);
      expect(closed.text).toContain(`Session ${session} closed`);
    } finally {
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('can observe the same session after cancelling an action in progress', async () => {
    const dir = project('await screen.pause();', `import { writeFileSync } from 'node:fs';
${CONFIG.replace('  video: true,', `  video: true,
  async perform(_ref, _action, { signal }) {
    writeFileSync(new URL('./action-started', import.meta.url), '');
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    writeFileSync(new URL('./action-cancelled', import.meta.url), '');
    throw new Error('tap cancelled');
  },`)}`);
    const held = await pause(dir);
    const { client } = await mcp(dir);
    const { session, text } = await attach(client, held.id);
    const target = /^[ \t]*#(\S+) button "Submit"/m.exec(text)?.[1];

    if (target === undefined) {
      throw new Error(text);
    }

    const cancel = new AbortController();
    const call = client.callTool(
      { name: 'call', arguments: { session, tool: 'tap', args: { target } } },
      { timeout: 25_000, signal: cancel.signal },
    );
    const cancelled = expect(call).rejects.toThrow();

    try {
      await vi.waitFor(() => expect(existsSync(path.join(dir, 'action-started'))).toBe(true), { timeout: 5_000 });
    } finally {
      cancel.abort();
      await cancelled;
    }

    await vi.waitFor(() => expect(existsSync(path.join(dir, 'action-cancelled'))).toBe(true), { timeout: 5_000 });
    const observed = await invoke(client, 'call', { session, tool: 'observe' });
    expect(observed.isError, observed.text).toBe(false);
    expect(observed.text).toContain('path /checkout');
  });

  it('leaves the test held and attachable again if the MCP server is killed', async () => {
    const dir = project(`await screen.pause(); ${STEP}`);
    const held = await pause(dir);
    const first = await mcp(dir);
    await attach(first.client, held.id);
    const pid = first.transport.pid;

    if (pid === null) {
      throw new Error('MCP server did not start');
    }

    process.kill(pid, 'SIGKILL');

    const { client } = await mcp(dir);
    const reopened = await vi.waitFor(() => attach(client, held.id), { timeout: 5_000 });
    expect(reopened.text).toContain('path /checkout');
  });

  it('keeps attached actions and their app logs out of the report and the trace page', async () => {
    const dir = project(`await screen.pause(); ${STEP}`);
    const held = await pause(dir, '--trace', 'on');
    const { client } = await mcp(dir);
    await attach(client, held.id);
    const navigated = await invoke(client, 'call', { tool: 'navigate', args: { url: '/attached-only' } });
    expect(navigated.isError, navigated.text).toBe(false);
    expect(navigated.text).toContain('/attached-only');

    expect(e2e(dir, 'run', '--step', 'next').status).toBe(0);
    expect(await held.exited).toBe(0);
    const report: Report1Document = JSON.parse(readFileSync(path.join(dir, '.e2e/report.json'), 'utf8'));
    expect(report.run.results[0]?.attempts[0]?.steps.map(({ api, label }) => ({ api, label }))).toEqual([
      { api: 'app.open', label: '/checkout' },
      { api: 'app.open', label: '/after' },
    ]);
    expect(JSON.stringify(report)).not.toContain('/attached-only');
    const pages = contentsUnder(path.join(dir, '.e2e/results')).filter(([file]) => file.endsWith('trace.md'));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.[1]).toContain('App log for /after');
    expect(pages[0]?.[1]).not.toContain('/attached-only');
  });

  it('keeps test code, recording and secret fills out of the attached catalog', async () => {
    const dir = project('await screen.pause();');
    const held = await pause(dir);
    const { client } = await mcp(dir);
    await attach(client, held.id);
    const { text } = await invoke(client, 'tools');
    for (const tool of ['run_code', 'start_recording', 'stop_recording', 'type_secret']) {
      expect(text).not.toContain(`- ${tool}`);
      const reply = await invoke(client, 'call', { tool });
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain(tool === 'type_secret' ? 'POLICY_DENIED' : 'UNKNOWN_TOOL');
    }
    const screenshot = await invoke(client, 'tools', { tool: 'screenshot' });
    expect(screenshot.isError).toBe(false);
    expect(screenshot.text).not.toContain('"path"');

    const screenshotWithPath = await invoke(client, 'call', { tool: 'screenshot', args: { path: 'shot.png' } });
    expect(screenshotWithPath.isError).toBe(true);
    expect(screenshotWithPath.text).toContain('INVALID_ARGUMENT');
    expect(screenshotWithPath.text).toContain('"path"');
    expect(screenshotWithPath.text).toContain('An attached session returns the image without saving a file.');
  });

  it('names both e2e versions when attachment protocols differ', async () => {
    const dir = project('await screen.pause();');
    await pause(dir);
    const version = e2e(dir, '--version').stdout.trim();
    const socket = net.connect(stepAddress(dir).socket);
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        let text = '';
        socket.setEncoding('utf8');
        socket.once('error', reject);
        socket.on('data', (chunk: string) => {
          text += chunk;
        });
        socket.once('end', () => resolve(text));
        socket.once('connect', () => socket.write('{"type":"hello","protocol":999,"version":"9.9.9"}\n'));
      });
      expect(JSON.parse(reply)).toMatchObject({
        type: 'error',
        category: 'configuration',
        message: expect.stringContaining(`e2e mcp (e2e 9.9.9) and e2e run (e2e ${version})`),
      });
      expect(reply).toContain('Run the same e2e version for e2e mcp and e2e run.');
    } finally {
      socket.destroy();
    }
  });
});
