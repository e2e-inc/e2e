/**
 * `run_code` end to end: the built CLI serving a fixture project over stdio
 * to a real MCP client, on the web engine and the fixture app. The code is
 * ordinary JavaScript in the server's Node process, on the objects a test
 * body gets, so each call waits, matches, and fails as it does in a test. An
 * uncaught failure stops the code within the call's timeout, and one nothing
 * awaited fails the call. A configured secret's value is redacted from what
 * comes back. The lines that pass join `test_lines`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');

const PASSWORD = 'admin-pass-7Qz';
const API_KEY = 'sk-live-RUNCODE-0000';

const CONFIG = `import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  targets: [{ name: 'web', engine: web(), app: { url: process.env.APP_URL! } }],
  credentials: { admin: { username: 'admin', password: ${JSON.stringify(PASSWORD)} } },
  secrets: { apiKey: ${JSON.stringify(API_KEY)} },
} satisfies E2EConfig;
`;

interface ToolText {
  readonly text: string;
  readonly isError: boolean;
  readonly images: number;
}

describe('e2e mcp run_code', { timeout: 120_000 }, () => {
  let app: FixtureApp;
  let project: FixtureProject;
  let client: Client;
  /** Every text a tool returned, to check no secret value ever left the server. */
  const returned: string[] = [];

  const invoke = async (name: string, args: Record<string, unknown> = {}): Promise<ToolText> => {
    const result = (await client.callTool({ name, arguments: args }, { timeout: 110_000 })) as {
      content: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = result.content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
    returned.push(text);
    return { text, isError: result.isError === true, images: result.content.filter((part) => part.type === 'image').length };
  };

  const call = (tool: string, args: Record<string, unknown> = {}): Promise<ToolText> => invoke('call', { tool, args });
  const runCode = (code: string, timeout?: number): Promise<ToolText> => call('run_code', { code, ...(timeout === undefined ? {} : { timeout }) });
  const nodeId = (text: string, pattern: RegExp): string => {
    const match = /#(n\d+)/.exec(text.split('\n').find((line) => pattern.test(line)) ?? '');
    if (match === null) throw new Error(`no node matches ${pattern} in:\n${text}`);
    return match[1]!;
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'e2e.config.ts': CONFIG });
    client = new Client({ name: 'e2e-mcp-run-code-test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [CLI, 'mcp'],
        cwd: project.dir,
        env: { ...(process.env as Record<string, string>), APP_URL: app.url, CI: '' },
        stderr: 'ignore',
      }),
    );
    const opened = await invoke('open_session');
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toMatch(/^- run_code \{code, timeout\?\}: JavaScript with loops, variables, and return values\. /m);
    expect(opened.text.match(/^- run_code /gm)).toHaveLength(1);
    expect(opened.text).toContain("fill(credentials.user('name').password)");
  }, 60_000);

  afterAll(async () => {
    await invoke('close_session').catch(() => undefined);
    await client?.close().catch(() => undefined);
    project?.cleanup();
    await app?.close();
  });

  it("runs lines on the session's fixtures with the test API's semantics, shows reads, and reports what changed", async () => {
    const result = await runCode(`await app.open('/');
await screen.getByRole('button', 'Increment').tap();
await expect(screen.getByRole('status', 'Counter')).toHaveText('1');
await screen.getByRole('status', 'Counter').textContent();
await screen.getByLabel('Plan').selectOption('Pro');
await expect(screen.getByLabel('Plan')).toHaveValue('pro');
await expect(screen.getByText('Late arrival')).toBeVisible();
await screen.getByTestId('item').allTextContents();`);
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toMatch(/^Ran; the code returned nothing\.\nTest lines: 8\.\n1\. await app\.open\('\/'\);\n/);
    expect(result.text).toContain("4. await screen.getByRole('status', 'Counter').textContent(); -> \"1\"\n");
    expect(result.text).toContain('-> ["Item Alpha","Item Beta","Item Gamma"]\n');
    expect(result.text).toMatch(/\n\n(?:Screen changes since revision|The screen changed substantially)/);
    expect(result.text).toContain('status "Counter" text="1"');

    const observed = await call('observe');
    expect(observed.text).toMatch(/combobox "Plan" value="pro"/);
  });

  it('stops at the first uncaught failure within the timeout, gives its code and message, and leaves the rest unrun', async () => {
    const started = Date.now();
    const missing = await runCode(
      `await screen.getByLabel('Emial').fill('ada@example.test');
await screen.getByRole('button', 'Increment').tap();`,
      500,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(
      /^Failed: LOCATOR_NOT_FOUND: locator matched no nodes within getByLabel\("Emial"\)\nThe app is where the lines that passed left it\.\nTest lines: 1, 1 failed\.\n1\. failed: await screen\.getByLabel\('Emial'\)\.fill\('ada@example\.test'\);\n {3}LOCATOR_NOT_FOUND: locator matched no nodes within getByLabel\("Emial"\)\n\nScreen unchanged since revision/,
    );
    expect(missing.text).not.toContain('Increment');

    const ambiguous = await runCode("await screen.getByRole('button', 'Increment').tap();\nawait screen.getByText('Duplicated').tap();\nawait app.back();");
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain("Test lines: 2, 1 failed.\n1. await screen.getByRole('button', 'Increment').tap();\n2. failed: await screen.getByText('Duplicated').tap();\n");
    expect(ambiguous.text).toContain('LOCATOR_AMBIGUOUS: locator matched 2 nodes, expected exactly one: getByText("Duplicated")');
    expect(ambiguous.text).not.toContain('app.back');

    const assertion = await runCode("await expect(screen.getByRole('status', 'Counter')).toHaveText('99');", 300);
    expect(assertion.isError).toBe(true);
    expect(assertion.text).toContain('ASSERTION_FAILED: expect.toHaveText failed\n   locator: getByRole("status", name: "Counter")\n   expected: text "99"\n   observed: text "2"');
  });

  it('runs the code as ordinary JavaScript in Node, on the real objects', async () => {
    const host = await runCode("const { basename } = await import('node:path');\nreturn [typeof process, typeof fetch, basename('/tmp/file.txt')];");
    expect(host.text).toMatch(/^Returned: \["object","function","file\.txt"\]\n/);
    const page = await runCode("await page.goto('/')");
    expect(page.isError).toBe(true);
    expect(page.text).toMatch(/^Failed: ReferenceError: page is not defined \(line 1:\d+\); the code has screen, app, expect, credentials, secrets, browser, console, /);
    const member = await runCode("const title = 1;\nawait screen.evaluate('document.title')");
    expect(member.isError).toBe(true);
    expect(member.text).toMatch(/^Failed: TypeError: screen\.evaluate is not a function \(line 2:\d+\)\n/);
    const syntax = await runCode('const first = 1;\nconst second = ;');
    expect(syntax.isError).toBe(true);
    expect(syntax.text).toMatch(/^Failed: INVALID_ARGUMENT: run_code: the code does not parse at line 2: /);
    // Strict, so the code leaves no name behind on the server's globals.
    const leaked = await runCode('leaked = 1;');
    expect(leaked.text).toMatch(/^Failed: ReferenceError: leaked is not defined/);
    const unchanged = await runCode("await expect(screen.getByRole('status', 'Counter')).toHaveText('2')", 300);
    expect(unchanged.isError, unchanged.text).toBe(false);
  });

  it('adds the lines that passed to test_lines, reads and failures aside, and keeps the ids its screen listed', async () => {
    const drafted = await call('test_lines');
    expect(drafted.text.split('\n').filter((line) => line.startsWith('await '))).toEqual([
      'await app.open();',
      "await app.open('/');",
      "await screen.getByRole('button', 'Increment').tap();",
      "await expect(screen.getByRole('status', 'Counter')).toHaveText('1');",
      "await screen.getByLabel('Plan').selectOption('Pro');",
      "await expect(screen.getByLabel('Plan')).toHaveValue('pro');",
      "await expect(screen.getByText('Late arrival')).toBeVisible();",
      "await screen.getByRole('button', 'Increment').tap();",
      "await expect(screen.getByRole('status', 'Counter')).toHaveText('2');",
    ]);
    // The next action's test line is read from the screen run_code returned.
    const echo = await runCode("await app.open('/echo');");
    const typed = await call('type', { target: nodeId(echo.text, /textbox "Token"/), value: 'typed by id' });
    expect(typed.text.split('\n')[1]).toBe('Test line: await screen.getByRole("textbox", "Token").fill("typed by id");');
    const home = await runCode("await app.open('/');");
    expect(home.isError, home.text).toBe(false);
  });

  it("calls any member of the engine's fixture, and hands it the code's own functions", async () => {
    const result = await runCode(`const before = await browser.url();
await browser.goto(before + 'echo');
const inputs = await browser.evaluate((selector) => document.querySelectorAll(selector).length, 'input');
await browser.locator('input').first().fill('by selector');
const value = await browser.evaluate(() => document.querySelector('input').value);
const tabs = await browser.tabs();
await browser.keyboard.press('Tab');
await browser.goto(before);
return { path: before.replace(/^https?:\\/\\/[^/]+/, ''), inputs: inputs > 0, value, tabs: tabs.length };`);
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toMatch(/^Returned: \{"path":"\/","inputs":true,"value":"by selector","tabs":1\}\n/);
    expect(result.text).toContain("await browser.locator('input').first().fill('by selector');\n");
    // A page script may change the page, so its line is kept, value or not.
    expect(result.text).toContain("await browser.evaluate(() => document.querySelector('input').value); -> \"by selector\"\n");
    expect(result.text).not.toMatch(/^\d+\. await browser\.locator\('input'\);$/m);

    // A handler is the code's own function, called in the server as a test's is.
    const routed = await runCode(`let requests = 0;
await browser.route('**/*', (route) => { requests++; return route.continue(); });
await browser.reload();
return requests > 0;`);
    expect(routed.text, routed.text).toMatch(/^Returned: true\n/);
    // What a call resolves with can be a function of the fixture's, called like any other.
    const handler = await runCode("const off = await browser.onDialog(() => {});\nawait off();\nreturn 'kept';");
    expect(handler.text, handler.text).toMatch(/^Returned: "kept"\n/);
    const missing = await runCode('await browser.teleport();');
    expect(missing.text).toMatch(/^Failed: TypeError: browser\.teleport is not a function/);
    const drafted = await call('test_lines');
    expect(drafted.text).toContain("\nawait browser.locator('input').first().fill('by selector');\n");
  });

  it('drafts a line a test can run for an object a fixture call awaited for', async () => {
    const result = await runCode(`const tab = await browser.newTab();
await tab.activate();
await tab.close();
return (await browser.reload()) === undefined;`);
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toMatch(/^Returned: true\n/);
    const drafted = await call('test_lines');
    expect(drafted.text).toMatch(/\nconst (newTab\d+) = await browser\.newTab\(\);\nawait \1\.activate\(\);\nawait \1\.close\(\);\nawait browser\.reload\(\);\n/);
    expect(drafted.text).toContain('async ({ app, screen, browser }) => { ... }');
  });

  it('drafts a page script that may change the page', async () => {
    const titled = await runCode("return await browser.evaluate(() => { document.title = 'Changed'; return document.title; });");
    expect(titled.text).toMatch(/^Returned: "Changed"\n/);
    expect((await call('test_lines')).text).toContain("\nawait browser.evaluate(() => { document.title = 'Changed'; return document.title; });\n");
  });

  it('runs a locator built with or, as a test would', async () => {
    const either = await runCode("await expect(screen.getByRole('button', 'Increment').or(screen.getByRole('button', 'Nowhere'))).toBeVisible();");
    expect(either.isError, either.text).toBe(false);
    expect(either.text).toContain('Test lines: 1.\n');
  });

  it('computes on what it reads: variables, loops, value assertions, a caught failure, a return value, and the console', async () => {
    const result = await runCode(
      `const counter = screen.getByRole('status', 'Counter');
const before = Number(await counter.textContent());
for (let i = 0; i < 3; i++) await screen.getByRole('button', 'Increment').tap();
const after = Number(await counter.textContent());
console.log('added', after - before);
expect(after - before).toBe(3);
let code;
try {
  await screen.getByRole('button', 'Nowhere').tap();
} catch (error) {
  code = error.code;
}
const items = (await screen.getByTestId('item').allTextContents()).map((text) => text.toUpperCase());
return { added: after - before, code, items };`,
      500,
    );
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toMatch(/^Returned: \{"added":3,"code":"LOCATOR_NOT_FOUND","items":\["ITEM ALPHA","ITEM BETA","ITEM GAMMA"\]\}\nconsole:\n {3}added 3\nTest lines: 7, 1 failed, 3 reads not listed\.\n1\. await screen\.getByRole\('button', 'Increment'\)\.tap\(\);\n/);
    expect(result.text).not.toContain('textContent(); -> ');

    const wrong = await runCode('expect([1, 2]).toHaveLength(3);');
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/^Failed: ASSERTION_FAILED: expected \[1,2\] to have length 3/);
  });

  it('lets a line the code did not await finish, and says so', async () => {
    const result = await runCode("screen.getByRole('button', 'Increment').tap();\nreturn 'early';");
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toMatch(/^Returned: "early"\nconsole:\n {3}1 call\(s\) on the app were not awaited when the code ended; .*\nTest lines: 1\.\n1\. await screen\.getByRole\('button', 'Increment'\)\.tap\(\);\n/);
  });

  it('fails on a failure the code did not await, on a promise it left, and on what a timer callback throws', async () => {
    // Settled while the code was busy elsewhere, and never waited on.
    const early = await runCode("screen.getByRole('button', 'Nowhere').tap();\nawait new Promise((resolve) => setTimeout(resolve, 700));\nreturn 'done';", 250);
    expect(early.isError).toBe(true);
    expect(early.text).toMatch(/^Failed: LOCATOR_NOT_FOUND: /);
    // Still running when the code ended.
    const late = await runCode("screen.getByRole('button', 'Nowhere').tap();\nreturn 'done';", 250);
    expect(late.isError).toBe(true);
    expect(late.text).toMatch(/^Failed: LOCATOR_NOT_FOUND: /);
    // Waited on and caught: the code handled it.
    const caught = await runCode("const tap = screen.getByRole('button', 'Nowhere').tap();\ntry { await tap; } catch { return 'caught'; }", 250);
    expect(caught.text, caught.text).toMatch(/^Returned: "caught"\n/);

    const left = await runCode("Promise.reject(new Error('left behind'));\nawait new Promise((resolve) => setTimeout(resolve, 60));\nreturn 'after';");
    expect(left.isError).toBe(true);
    expect(left.text).toMatch(/^Failed: Error: left behind \(line 1:\d+\)\n/);
    const timer = await runCode("setTimeout(() => { expect(1).toBe(2); }, 10);\nawait new Promise((resolve) => setTimeout(resolve, 60));\nreturn 'after';");
    expect(timer.isError).toBe(true);
    expect(timer.text).toMatch(/^Failed: ASSERTION_FAILED: expected 1 to be 2/);
    // The server is still serving: none of those reached the process.
    const still = await runCode("return 'alive';");
    expect(still.text).toMatch(/^Returned: "alive"\n/);
  });

  it('stops a cancelled call, even one that swallows every failure, and keeps a list a real array', async () => {
    const stop = new AbortController();
    // Left alone this loop runs for the call's whole five minutes, and the session takes one call at a time.
    const looping = client
      .callTool(
        { name: 'call', arguments: { tool: 'run_code', args: { code: "for (;;) { try { await screen.getByRole('button', 'Nowhere').tap(); } catch {} }", timeout: 100 } } },
        { signal: stop.signal, timeout: 110_000 },
      )
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 600));
    stop.abort();
    await looping;
    const started = Date.now();
    const next = await runCode(`const items = await screen.getByTestId('item').all();
return { array: Array.isArray(items), texts: await Promise.all(items.map((item) => item.textContent())) };`);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(next.text, next.text).toMatch(/^Returned: \{"array":true,"texts":\["Item Alpha","Item Beta","Item Gamma"\]\}\n/);
  });

  describe('secrets', () => {
    it('fills a secret as a test does, keeps a secure field unreadable, and keeps the screenshot after the fill', async () => {
      const before = await call('screenshot');
      expect(before.images).toBe(1);

      const unconfigured = await runCode("await screen.getByLabel('Password').fill(credentials.user('ghost').password);");
      expect(unconfigured.text).toContain('AUTH_CREDENTIAL_UNAVAILABLE: credential "ghost" is not configured');
      const unknown = await runCode("await screen.getByLabel('Email').fill(secrets.get('stripeKey'));");
      expect(unknown.text).toContain('SECRET_UNAVAILABLE: secret "stripeKey" is not configured');
      const signedIn = await runCode(`await screen.getByLabel('Email').fill(credentials.user('admin').username);
await screen.getByLabel('Password').fill(credentials.user('admin').password);`);
      expect(signedIn.isError, signedIn.text).toBe(false);
      expect(signedIn.text).toContain('Test lines: 2.\n');
      const read = await runCode("await screen.getByLabel('Password').inputValue();");
      expect(read.isError).toBe(true);
      expect(read.text).toContain('POLICY_DENIED: reading values from a secure field is denied: getByLabel("Password")');

      const after = await call('screenshot');
      expect(after.images).toBe(1);
    });

    it('redacts a secret from every read, failure, and value that comes back', async () => {
      const filled = await runCode(`await app.open('/echo');
await screen.getByLabel('Token').fill(secrets.get('apiKey'));`);
      expect(filled.isError, filled.text).toBe(false);
      // The short timeout is for the assertion meant to fail; the open and the fill above need the default one under load.
      const echoed = await runCode(`await screen.getByLabel('Token').inputValue();
await screen.getByTestId('plain').textContent();
await expect(screen.getByTestId('plain')).toHaveText('nothing yet');`, 300);
      expect(echoed.isError).toBe(true);
      expect(echoed.text).toContain("1. await screen.getByLabel('Token').inputValue(); -> \"<secret:apiKey>\"\n");
      expect(echoed.text).toContain("2. await screen.getByTestId('plain').textContent(); -> \"<secret:apiKey>\"\n");
      expect(echoed.text).toContain('3. failed:');
      const message = await runCode("try { await expect(screen.getByTestId('plain')).toHaveText('nothing yet'); } catch (error) { return { code: error.code, message: error.message }; }", 300);
      expect(message.text).toMatch(/^Returned: \{"code":"ASSERTION_FAILED",/);
      const page = await runCode("return await browser.evaluate(() => Array.from(document.querySelectorAll('input')).map((input) => input.value));");
      expect(page.isError, page.text).toBe(false);
      expect(page.text).toMatch(/^Returned: \[.*"<secret:apiKey>".*\]\n/);
    });

    it('compares and finds by the real text, as a test does, so a line that passes here passes there', async () => {
      // The secret from the test before is still in the Token field and its echo.
      const real = await runCode(`await expect(screen.getByLabel('Token')).toHaveValue(/^sk-l/);
return await screen.getByDisplayValue(/^sk-l/).count();`);
      expect(real.isError, real.text).toBe(false);
      expect(real.text).toMatch(/^Returned: 1\n/);
      // The marker is what the result shows, not what the field holds.
      const marker = await runCode("await expect(screen.getByTestId('plain')).toHaveText('<secret:apiKey>');", 300);
      expect(marker.isError).toBe(true);
      expect(marker.text).toContain('ASSERTION_FAILED');
    });

    it('drafts the secret fills it ran in test_lines by name', async () => {
      const drafted = await call('test_lines');
      expect(drafted.text).toContain("\nawait screen.getByLabel('Password').fill(credentials.user('admin').password);\n");
      expect(drafted.text).toContain("\nawait screen.getByLabel('Token').fill(secrets.get('apiKey'));\n");
      expect(drafted.text).toContain("Import credentials and secrets from 'e2e'.");
    });

    it('never returns a secret value', () => {
      for (const text of returned) {
        expect(text).not.toContain(PASSWORD);
        expect(text).not.toContain(API_KEY);
        expect(text.toLowerCase()).not.toContain(API_KEY.toLowerCase());
      }
    });
  });
});
