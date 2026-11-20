/**
 * Drives the built CLI on the fake engine. Pipes carry the keys and output.
 * A terminal stand-in supplies the size and resize events to the child.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it, type TestContext } from 'vitest';
import type { Report1Document } from '../../src/report/build.ts';
import { FAKE_APP_URL } from '../helpers/fake-engine.ts';
import { PAUSE_ID_PATTERN, printedPauseId } from '../helpers/pause-id.ts';
import { createProject, workerFakeConfigSource } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const ENV = { ...process.env, CI: '', NO_COLOR: '1' };
const POLL = { timeout: 10_000, interval: 20 };
const KEY_GUARD_MS = 400;
const ACTIVE_WORK_MS = 150;
const ENTER_SCREEN = '\u001b[?1049h';
const HIDE_CURSOR = '\u001b[?25l';
const RESTORE_SCREEN = '\u001b[?1049l\u001b[?25h';
const CLEAR_SCREEN = '\u001b[H\u001b[2J';
const STEP_PROMPT = new RegExp(`Paused \\(${PAUSE_ID_PATTERN.source}\\) at step 2`);
const PAUSE_PROMPT = new RegExp(`Paused \\(${PAUSE_ID_PATTERN.source}\\) at screen\\.pause\\(\\)`);

const TERMINAL = `
Object.assign(process.stdin, { isTTY: true });
Object.assign(process.stdout, { isTTY: true, rows: 10, columns: 120 });

process.on('message', ({ rows, columns }) => {
  Object.assign(process.stdout, { rows, columns });
  process.stdout.emit('resize');
});
process.channel.unref();
`;

const STEPS = `import { test } from 'e2e';

test('checks out', async ({ app }) => {
  await app.open('/cart');
  await app.open('/receipt');
  console.log('The test reached the receipt.');
});
`;

const TIMED_STEPS = `import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'e2e';

test('checks out', async ({ app }) => {
  await app.open('/cart');
  await app.open('/receipt');
  await sleep(${ACTIVE_WORK_MS});
});
`;

const PAUSE = `import { test } from 'e2e';

test('checks out', async ({ app, screen }) => {
  await app.open('/cart');
  await screen.pause();
  await app.open('/receipt');
  console.log('The test reached the receipt.');
});
`;

const APP = `import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

let log;
const { engine } = createFakeEngine({
  tree: {
    ref: { id: 'items', revision: '' },
    role: 'list',
    children: Array.from({ length: 20 }, (_, index) => ({
      ref: { id: String(index), revision: '' },
      role: 'button',
      name: 'Item ' + String(index + 1).padStart(2, '0') + (index === 0 ? ' ' + 'x'.repeat(140) : ''),
    })),
  },
  onStartAttempt(context) {
    log = context.appLog;
    log({ source: 'console', level: 'info', text: 'App started' });
  },
  onNavigate(url) {
    if (url.endsWith('/cart')) {
      for (let line = 1; line <= 9; line++) {
        log({ source: 'console', level: 'info', text: 'Cart line ' + line });
      }
      log({ source: 'network', level: 'error', text: 'GET /checkout 500' });
    }
  },
});

export default { targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }] };
`;

/** Starts a project on the terminal stand-in and stops the child before removing the project. */
function terminalRun(
  { onTestFinished }: TestContext,
  files: Readonly<Record<string, string>>,
  args: readonly string[],
) {
  const project = createProject({ 'terminal.mjs': TERMINAL, ...files });
  const child = spawn(process.execPath, ['--import', './terminal.mjs', CLI, 'run', ...args], {
    cwd: project.dir,
    env: ENV,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  const { stdin, stdout: outputStream, stderr: errorStream } = child;
  assert(stdin && outputStream && errorStream, 'the child needs pipes for its terminal');
  let stdout = '';
  let stderr = '';
  outputStream.setEncoding('utf8');
  errorStream.setEncoding('utf8');
  outputStream.on('data', (chunk: string) => {
    stdout += chunk;
  });
  errorStream.on('data', (chunk: string) => {
    stderr += chunk;
  });

  onTestFinished(async () => {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 3_000);

    try {
      await exited;
    } finally {
      clearTimeout(force);
      project.cleanup();
    }
  });

  return {
    dir: project.dir,
    exited,
    output: (from = 0) => stdout.slice(from),
    printed: (from = 0) => stripVTControlCharacters(stdout.slice(from)),
    /** Sends a key sequence and marks where its output will start. */
    press(keys: string): number {
      const from = stdout.length;
      stdin.write(keys);
      return from;
    },
    /** Changes the terminal size while the CLI is running. */
    resize(rows: number, columns: number): number {
      const from = stdout.length;
      child.send({ rows, columns });
      return from;
    },
    /** Waits for fresh output when a key can print a line the run has already shown. */
    async shows(text: string | RegExp, from = 0): Promise<void> {
      const printed = expect.poll(() => stripVTControlCharacters(stdout.slice(from)), POLL);

      if (typeof text === 'string') {
        await printed.toContain(text);
      } else {
        await printed.toMatch(text);
      }
    },
    /** Waits for a new viewer frame with the given range and returns its text. */
    async frame(range: string, from: number): Promise<string> {
      const frame = () => {
        const output = stdout.slice(from);
        const start = output.lastIndexOf(CLEAR_SCREEN);
        return start === -1 ? '' : stripVTControlCharacters(output.slice(start + CLEAR_SCREEN.length));
      };

      await expect.poll(frame, POLL).toMatch(new RegExp(`^[^\\r\\n]* ${range}\\r\\n[\\s\\S]*\\r\\n  press ↑ ↓ to scroll`));
      return frame();
    },
    /** Checks the status with both streams available when the CLI exits early. */
    async finishes(code: number): Promise<void> {
      expect(await exited, stripVTControlCharacters(stdout + stderr)).toBe(code);
    },
  };
}

/** Starts the CLI and waits until the first prompt accepts keys. */
async function heldRun(
  context: TestContext,
  { suite = STEPS, config = APP, args = ['--step'], prompt = STEP_PROMPT } = {},
) {
  const run = terminalRun(context, { 'e2e.config.ts': config, 'tests/checkout.e2e.ts': suite }, args);
  await run.shows(prompt);
  await sleep(KEY_GUARD_MS);
  return run;
}

/** Reads the last terminal Duration row in milliseconds. */
function durationMs(output: string): number {
  const row = [...output.matchAll(/^ +Duration +(\d+(?:\.\d+)?)(ms|s)\b/gm)].at(-1);
  assert(row?.[1] !== undefined, 'the run printed a Duration row');
  return Math.round(Number(row[1]) * (row[2] === 's' ? 1_000 : 1));
}

/** Reads the wall time between the run timestamps in report.json. */
function reportWallMs(dir: string): number {
  const { run }: Report1Document = JSON.parse(readFileSync(path.join(dir, '.e2e', 'report.json'), 'utf8'));
  return Date.parse(run.finishedAt) - Date.parse(run.startedAt);
}

describe('the terminal run duration', () => {
  it('freezes Duration while a step waits and prints only active time at the end', async (context) => {
    const run = terminalRun(context, {
      'e2e.config.ts': APP,
      'tests/checkout.e2e.ts': TIMED_STEPS,
    }, ['--step']);
    await run.shows(STEP_PROMPT);
    const held = durationMs(run.printed());

    await sleep(KEY_GUARD_MS);
    const repaint = run.output().length;
    await run.shows(STEP_PROMPT, repaint);
    expect(durationMs(run.printed(repaint))).toBe(held);

    const releasedAt = performance.now();
    run.press('\r');
    await run.finishes(0);
    const activeAfterRelease = durationMs(run.printed()) - held;
    expect(activeAfterRelease).toBeGreaterThanOrEqual(ACTIVE_WORK_MS - 10);
    expect(activeAfterRelease).toBeLessThanOrEqual(Math.ceil(performance.now() - releasedAt) + 10);
    expect(reportWallMs(run.dir)).toBeGreaterThanOrEqual(held + KEY_GUARD_MS + ACTIVE_WORK_MS - 20);
  });

  it('counts elapsed time when the run has no holds', async (context) => {
    const startedAt = performance.now();
    const run = terminalRun(context, {
      'e2e.config.ts': APP,
      'tests/checkout.e2e.ts': TIMED_STEPS,
    }, []);
    await run.finishes(0);

    const elapsed = durationMs(run.printed());
    expect(elapsed).toBeGreaterThanOrEqual(ACTIVE_WORK_MS - 10);
    expect(elapsed).toBeGreaterThanOrEqual(reportWallMs(run.dir) - 20);
    expect(elapsed).toBeLessThanOrEqual(Math.ceil(performance.now() - startedAt) + 10);
  });

  it('starts a fresh Duration when watch runs the test again', async (context) => {
    const suite = `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';

test('checks out', async ({ app, screen }) => {
  await app.open('/cart');
  const receipt = new URL('../.e2e/has-paused', import.meta.url);

  if (!existsSync(receipt)) {
    await screen.pause();
    writeFileSync(receipt, '');
  }

  await app.open('/receipt');
});
`;
    const run = await heldRun(context, { suite, args: ['--watch'], prompt: PAUSE_PROMPT });
    await run.shows('Waiting for file changes...', run.press('\r'));

    const rerun = run.press('a');
    await run.shows('Waiting for file changes...', rerun);
    expect(run.printed(rerun)).toContain('1 passed (1)');
    expect(run.printed(rerun)).not.toMatch(PAUSE_PROMPT);
    expect(durationMs(run.printed(rerun))).toBeGreaterThanOrEqual(reportWallMs(run.dir) - 20);

    run.press('q');
    await run.finishes(0);
  });
});

describe('the terminal screen and app log viewer', () => {
  it("shows the held step's screen and returns to the same prompt on q", async (context) => {
    const run = await heldRun(context);
    const pauseId = printedPauseId(run.printed());
    const opened = run.press('s');
    const screen = await run.frame('1-6 of 22', opened);

    expect(run.output(opened)).toContain(ENTER_SCREEN);
    expect(screen).toContain('Screen before step 2 · checks out [fake]');
    expect(screen).toContain(FAKE_APP_URL);
    expect(screen).toContain('button "Item 02"');

    const closed = run.press('q');
    await run.shows(`Paused (${pauseId}) at step 2`, closed);
    expect(run.output(closed)).toContain(RESTORE_SCREEN);
    expect(run.printed()).not.toContain('The test reached the receipt.');
  });

  it('opens the app log at the newest lines and switches between the log and screen', async (context) => {
    const run = await heldRun(context);
    const opened = run.press('l');
    const newest = await run.frame('6-11 of 11', opened);

    expect(newest).toContain('App log · checks out [fake]');
    expect(newest).toContain('step 1 · ℹ console: `Cart line 5`');
    expect(newest).toContain('step 1 · ✗ network error: `GET /checkout 500`');
    expect(newest).not.toContain('App started');
    expect(newest.indexOf('Cart line 5')).toBeLessThan(newest.indexOf('GET /checkout 500'));

    const oldest = await run.frame('1-6 of 11', run.press('g'));
    expect(oldest).toContain('before step 1 · ℹ console: `App started`');

    const screen = await run.frame('1-6 of 22', run.press('s'));
    expect(screen).toContain('Screen before step 2 · checks out [fake]');
    expect(await run.frame('6-11 of 11', run.press('l'))).toContain('App log · checks out [fake]');
    expect(run.output(opened).split(ENTER_SCREEN)).toHaveLength(2);
    expect(run.output(opened)).not.toContain(RESTORE_SCREEN);
  });

  it('scrolls one line or page at a time and stops at the top and bottom', async (context) => {
    const run = await heldRun(context);
    await run.frame('1-6 of 22', run.press('s'));

    const scroll: readonly [keys: string, range: string][] = [
      ['\u001b[A', '1-6 of 22'],
      ['\u001b[B', '2-7 of 22'],
      ['k', '1-6 of 22'],
      ['j', '2-7 of 22'],
      ['\u001b[6~', '8-13 of 22'],
      ['\u001b[5~', '2-7 of 22'],
      [' ', '8-13 of 22'],
      ['b', '2-7 of 22'],
      ['G', '17-22 of 22'],
      [' ', '17-22 of 22'],
      ['g', '1-6 of 22'],
    ];

    for (const [keys, range] of scroll) {
      await run.frame(range, run.press(keys));
    }
  });

  it('prints the screen as permanent lines above the live prompt on p', async (context) => {
    const run = await heldRun(context);
    const visible = await run.frame('1-6 of 22', run.press('s'));
    expect(visible).not.toContain('Item 20');

    const printed = run.press('p');
    await run.shows('button "Item 20"', printed);
    const output = run.output(printed);
    const restored = output.indexOf(RESTORE_SCREEN);
    expect(restored).toBeGreaterThanOrEqual(0);
    const mainScreen = stripVTControlCharacters(output.slice(restored + RESTORE_SCREEN.length));
    expect(mainScreen).toContain('Screen before step 2 · checks out [fake]');
    expect(mainScreen).toContain('button "Item 20"');
    await run.shows(STEP_PROMPT, printed + output.indexOf('button "Item 20"'));

    await sleep(KEY_GUARD_MS);
    run.press('\r');
    await run.finishes(0);
    expect(run.printed()).toContain('The test reached the receipt.');
  });

  it('keeps the step held on Enter in the viewer and on a repeated q when it closes', async (context) => {
    const run = await heldRun(context);
    await run.frame('1-6 of 22', run.press('s'));

    await run.frame('2-7 of 22', run.press('\r\u001b[B'));
    expect(run.printed()).not.toContain('The test reached the receipt.');

    const closed = run.press('qq');
    await run.shows(STEP_PROMPT, closed);
    await sleep(KEY_GUARD_MS);
    run.press('\r');
    await run.finishes(0);
    expect(run.printed()).toContain('The test reached the receipt.');
  });

  it('restores the main screen and interrupts the run on Ctrl-C in the viewer', async (context) => {
    const run = await heldRun(context);
    const held = durationMs(run.printed());
    const opened = run.press('s');
    await run.frame('1-6 of 22', opened);
    expect(run.output(opened)).toContain(ENTER_SCREEN + HIDE_CURSOR);

    const interruptedAt = performance.now();
    const interrupted = run.press('\u0003');
    await run.finishes(130);
    const output = run.output(interrupted);
    expect(output).toContain(RESTORE_SCREEN);
    expect(stripVTControlCharacters(output.slice(output.indexOf(RESTORE_SCREEN)))).toContain('1 interrupted');
    expect(run.printed()).not.toContain('The test reached the receipt.');
    expect(durationMs(run.printed(interrupted)) - held).toBeLessThanOrEqual(Math.ceil(performance.now() - interruptedAt) + 10);
  });

  it('restores the main screen and exits watch mode on Ctrl-C in the viewer', async (context) => {
    const run = await heldRun(context, { suite: PAUSE, args: ['--watch'], prompt: PAUSE_PROMPT });
    await run.frame('1-6 of 22', run.press('s'));

    const interrupted = run.press('\u0003');
    await run.finishes(130);
    const output = run.output(interrupted);
    expect(output).toContain(RESTORE_SCREEN);
    expect(stripVTControlCharacters(output.slice(output.indexOf(RESTORE_SCREEN)))).toContain('1 interrupted');
  });

  it('closes the viewer when the worker exits while the step is held', async (context) => {
    const suite = `import { existsSync } from 'node:fs';
import { test } from 'e2e';

test('checks out', async ({ app }) => {
  await app.open('/cart');
  const timer = setInterval(() => {
    if (existsSync(new URL('../exit-worker', import.meta.url))) process.exit(7);
  }, 20);

  try {
    await app.open('/receipt');
  } finally {
    clearInterval(timer);
  }
});
`;
    const run = await heldRun(context, { suite });
    const held = durationMs(run.printed());
    await run.frame('1-6 of 22', run.press('s'));

    const before = run.output().length;
    const stoppedAt = performance.now();
    writeFileSync(path.join(run.dir, 'exit-worker'), '');
    await run.finishes(3);
    const output = run.output(before);
    expect(output).toContain(RESTORE_SCREEN);
    expect(stripVTControlCharacters(output.slice(output.indexOf(RESTORE_SCREEN)))).toContain('WORKER_CRASH');
    expect(durationMs(run.printed(before)) - held).toBeLessThanOrEqual(Math.ceil(performance.now() - stoppedAt) + 10);
  });

  it('prints output from another worker in order after the viewer closes', async (context) => {
    const other = `import { existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { test } from 'e2e';

test('prints while checkout is paused', async () => {
  while (!existsSync(new URL('../print', import.meta.url))) {
    await setTimeout(20);
  }

  console.log('First line from the other test.');
  console.log('Second line from the other test.');
});
`;
    const config = `import { writeFileSync } from 'node:fs';
` + workerFakeConfigSource(2, `
  reporters: [
    'list',
    {
      name: 'record received output',
      onOutput({ text }) {
        if (text.includes('Second line from the other test.')) {
          writeFileSync(new URL('./received', import.meta.url), '');
        }
      },
    },
  ],
`);
    const run = terminalRun(context, {
      'e2e.config.ts': config,
      'tests/checkout.e2e.ts': PAUSE,
      'tests/other.e2e.ts': other,
    }, []);
    await run.shows(PAUSE_PROMPT);
    const held = durationMs(run.printed());
    await sleep(KEY_GUARD_MS);
    const opened = run.press('s');
    await run.shows('button "Submit"', opened);

    writeFileSync(path.join(run.dir, 'print'), '');
    await expect.poll(() => existsSync(path.join(run.dir, 'received')), POLL).toBe(true);
    const alternateScreen = stripVTControlCharacters(run.output(opened).split(ENTER_SCREEN).at(-1) ?? '');
    expect(alternateScreen).not.toContain('First line from the other test.');
    expect(alternateScreen).not.toMatch(PAUSE_PROMPT);

    const closed = run.press('q');
    await run.shows('Second line from the other test.', closed);
    const output = run.output(closed);
    expect(output).toContain(RESTORE_SCREEN);
    const mainScreen = stripVTControlCharacters(output.slice(output.indexOf(RESTORE_SCREEN)));
    expect(mainScreen).toContain('First line from the other test.');
    expect(mainScreen.indexOf('First line from the other test.')).toBeLessThan(mainScreen.indexOf('Second line from the other test.'));
    await run.shows(PAUSE_PROMPT, closed);
    expect(durationMs(run.printed(closed))).toBe(held);

    await sleep(KEY_GUARD_MS);
    run.press('\r');
    await run.finishes(0);
  });

  it('says when the screen could not be read', async (context) => {
    const config = `import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

const { engine } = createFakeEngine({
  observe() {
    throw new Error('The app closed the screen.');
  },
});
export default { targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }] };
`;
    const run = await heldRun(context, { config });
    const opened = run.press('s');
    await run.shows('The screen could not be read.', opened);
    expect(run.printed(opened)).toContain('Screen before step 2 · checks out [fake]');

    const closed = run.press('q');
    await run.shows(STEP_PROMPT, closed);
    await sleep(KEY_GUARD_MS);
    run.press('\r');
    await run.finishes(0);
  });

  it('clips long lines to the terminal width and redraws when the terminal resizes', async (context) => {
    const run = await heldRun(context);
    const first = await run.frame('1-6 of 22', run.press('s'));
    const longLine = /^ {2}button "Item 01 x+…$/;
    expect(first.split('\r\n').find((line) => line.includes('Item 01'))).toMatch(longLine);

    const columns = 65;
    const resized = await run.frame('1-4 of 22', run.resize(8, columns));
    const lines = resized.split('\r\n');
    expect(lines).toHaveLength(8);
    expect(lines.every((line) => line.length <= columns)).toBe(true);
    expect(lines.find((line) => line.includes('Item 01'))).toMatch(longLine);
    expect(lines).toContain('  button "Item 02"');
  });

  it('shows the screen and tells you the app log is empty at a pause without --step', async (context) => {
    const run = await heldRun(context, {
      suite: PAUSE,
      config: workerFakeConfigSource(1),
      args: [],
      prompt: PAUSE_PROMPT,
    });

    const screen = run.press('s');
    await run.shows('button "Submit"', screen);
    expect(run.printed(screen)).toContain('Screen at screen.pause() · checks out [fake]');
    await run.shows(PAUSE_PROMPT, run.press('q'));
    await sleep(KEY_GUARD_MS);

    const log = run.press('l');
    await run.shows('The app has not logged anything.', log);
    expect(run.printed(log)).toContain('App log · checks out [fake]');
    await run.shows(PAUSE_PROMPT, run.press('q'));

    await sleep(KEY_GUARD_MS);
    run.press('\r');
    await run.finishes(0);
    expect(run.printed()).toContain('The test reached the receipt.');
  });

  it.for([
    { title: 'pause', suite: PAUSE, args: [], prompt: PAUSE_PROMPT },
    { title: 'held step', suite: STEPS, args: ['--step'], prompt: STEP_PROMPT },
  ])('closes the viewer and the MCP session when e2e run --step next resumes the $title', async (options, context) => {
    const run = await heldRun(context, options);
    const attach = printedPauseId(run.printed());
    await run.frame('1-6 of 22', run.press('s'));

    const client = new Client({ name: 'step-viewer-test', version: '1.0.0' });
    context.onTestFinished(() => client.close());
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp'],
      cwd: run.dir,
      env: { TMPDIR: tmpdir(), E2E_TELEMETRY_DISABLED: '1', E2E_UPDATE_CHECK_DISABLED: '1' },
      stderr: 'pipe',
    }));

    const opened = await client.callTool({ name: 'open_session', arguments: { attach } });
    expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
    const opening = opened.content.find((part) => part.type === 'text');
    const session = /^Session (\S+) open on target/.exec(opening?.text ?? '')?.[1];
    assert(session !== undefined, 'open_session names the attached session');

    const observed = await client.callTool({ name: 'call', arguments: { session, tool: 'observe' } });
    expect(observed.isError, JSON.stringify(observed.content)).not.toBe(true);
    expect(run.output()).not.toContain(RESTORE_SCREEN);

    const before = run.output().length;
    const next = spawnSync(process.execPath, [CLI, 'run', '--step', 'next'], {
      cwd: run.dir,
      env: ENV,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(next.error).toBeUndefined();
    expect(next.status, next.stderr + next.stdout + run.printed()).toBe(0);
    await run.finishes(0);

    const output = run.output(before);
    expect(output).toContain(RESTORE_SCREEN);
    expect(stripVTControlCharacters(output.slice(output.indexOf(RESTORE_SCREEN)))).toContain('The test reached the receipt.');

    const ended = await client.callTool({ name: 'call', arguments: { session, tool: 'observe' } });
    expect(ended.isError).toBe(true);
  });
});
