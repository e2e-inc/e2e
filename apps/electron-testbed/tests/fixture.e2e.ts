import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from '@e2e-dev/electron';
import { credentials, expect } from 'e2e';

/** The page's document, as far as these tests read it: the project compiles without the DOM library. */
interface PageGlobals {
  readonly document: { readonly title: string; querySelector(selector: string): { readonly type: string } | null };
}

/** What a rejected step threw, for checking its code. */
function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

test.describe('electron.launch', () => {
  test('gives the test its data directory before the app runs, and launches on what it put there', async ({ electron }) => {
    expect(existsSync(electron.userDataDir)).toBe(true);
    writeFileSync(path.join(electron.userDataDir, 'seeded'), 'by the test');
    await electron.launch();
    const read = await electron.evaluate(({ app }) => {
      const fs = process.getBuiltinModule('node:fs');
      const file = process.getBuiltinModule('node:path').join(app.getPath('userData'), 'seeded');
      return fs.readFileSync(file, 'utf8');
    });
    expect(read).toBe('by the test');
  });

  test('adds arguments and variables of the test\'s own, and keeps them through a restart', async ({ app, screen, electron }) => {
    const launched = (): Promise<{ readonly args: readonly string[]; readonly mode: string | undefined }> =>
      electron.evaluate(() => ({ args: process.argv.filter((argument) => argument.startsWith('--greeting=') || argument === '--per-test'), mode: process.env['TESTBED_MODE'] }));
    await electron.launch({ args: ['--per-test'], env: { TESTBED_MODE: 'per-test' } });
    await expect(screen.getByRole('heading', 'Hello from e2e')).toBeVisible();
    // After the target's own arguments, and over the engine's `env`, which is still there.
    expect(await launched()).toEqual({ args: ['--greeting=Hello from e2e', '--per-test'], mode: 'per-test' });
    expect(await electron.evaluate(() => process.env['E2E_ELECTRON_HIDDEN'])).toBeDefined();
    await app.restart();
    expect(await launched()).toEqual({ args: ['--greeting=Hello from e2e', '--per-test'], mode: 'per-test' });
  });

  test('starts the app\'s process in the directory the test names', async ({ electron }) => {
    await electron.launch({ cwd: 'app' });
    expect(await electron.evaluate(() => process.cwd())).toMatch(/electron-testbed[\\/]app$/);
  });

  test('starts the next test without them', async ({ app, screen, electron }) => {
    await app.open();
    await expect(screen.getByRole('heading', 'Hello from e2e')).toBeVisible();
    expect(await electron.evaluate(() => process.env['TESTBED_MODE'] ?? null)).toBeNull();
  });

  test('refuses an argument the engine owns, a variable it never sets, and an option it does not know', async ({ electron }) => {
    expect(await failure(electron.launch({ args: ['--user-data-dir=/tmp/elsewhere'] }))).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('electron.launch({ args })') });
    expect(await failure(electron.launch({ env: { TOKEN: credentials.user('ada').password as never } }))).toMatchObject({ code: 'POLICY_DENIED' });
    expect(await failure(electron.launch({ env: { NODE_OPTIONS: '--inspect' } }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await failure(electron.launch({ cwd: 'no-such-directory' }))).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('not a directory') });
    expect(await failure(electron.launch({ headless: true } as never))).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

test.describe('the app not running', () => {
  test('has no active window to hand out', async ({ electron }) => {
    let thrown: unknown;
    try {
      electron.activeWindow();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'INVALID_STATE' });
  });
});

test.describe('electron.keyboard and a window\'s page', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
  });

  test('types and presses into whatever holds focus, with a held modifier', async ({ screen, electron }) => {
    const username = screen.getByRole('textbox', 'Username');
    await username.focus();
    await electron.keyboard.type('ada', { delay: 5 });
    await expect(username).toHaveValue('ada');
    await electron.keyboard.down('Shift');
    await electron.keyboard.press('ArrowLeft');
    await electron.keyboard.up('Shift');
    await electron.keyboard.press('Backspace');
    await expect(username).toHaveValue('ad');
    await electron.keyboard.press('ControlOrMeta+A');
    await electron.keyboard.insertText('grace');
    await expect(username).toHaveValue('grace');
    // A chord with a modifier the test holds leaves it held: the next arrow still selects.
    await username.fill('ada');
    await electron.keyboard.down('Shift');
    await electron.keyboard.press('Shift+ArrowLeft');
    await electron.keyboard.press('ArrowLeft');
    await electron.keyboard.up('Shift');
    await electron.keyboard.press('Backspace');
    await expect(username).toHaveValue('a');
    expect(await failure(electron.keyboard.down('NoSuchKey'))).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(await failure(electron.keyboard.type(credentials.user('ada').password as never))).toMatchObject({ code: 'POLICY_DENIED' });
  });

  test('runs code in the active window\'s page, with its argument and its own error', async ({ electron }) => {
    const window = electron.activeWindow();
    expect(window.isActive()).toBe(true);
    expect(await window.evaluate(() => (globalThis as unknown as PageGlobals).document.title)).toBe('Sign In');
    expect(await window.evaluate((name: string) => (globalThis as unknown as PageGlobals).document.querySelector(`[name=${name}]`)?.type, 'password')).toBe('password');
    expect(await window.evaluate(async () => await Promise.resolve({ nested: [1, 2] }))).toEqual({ nested: [1, 2] });
    expect(await failure(window.evaluate(() => { throw new Error('from the page'); }))).toMatchObject({ code: 'EVALUATE_FAILED', message: expect.stringContaining('from the page') });
    expect(await failure(window.evaluate((held: unknown) => held, { nested: [credentials.user('ada').password] }))).toMatchObject({ code: 'POLICY_DENIED' });
    // What comes back is plain data, as from the main process: a bigint as its digits, a function left out.
    expect(await window.evaluate(() => ({ big: 10n, run: () => 1, kept: 'yes' }))).toEqual({ big: '10', kept: 'yes' });
    // The new document is there when reload() resolves: what the old one held is gone, with no wait.
    await window.evaluate(() => {
      (globalThis as { marked?: boolean }).marked = true;
    });
    await window.reload();
    expect(await window.evaluate(() => (globalThis as { marked?: boolean }).marked ?? null)).toBeNull();
    expect(await window.evaluate(() => (globalThis as unknown as { document: { readyState: string } }).document.readyState)).toBe('complete');
  });

  test('moves, presses, and scrolls with the mouse where the test points it', async ({ screen, electron }) => {
    const box = await screen.getByRole('button', 'Add one').boundingBox();
    if (box === null) throw new Error('the button has no box');
    await electron.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await electron.mouse.down();
    await electron.mouse.up();
    await expect(screen.getByTestId('count')).toHaveText('1');
    // A right press is no click.
    await electron.mouse.down({ button: 'right' });
    await electron.mouse.up({ button: 'right' });
    await expect(screen.getByTestId('count')).toHaveText('1');
    const scrolled = (): Promise<number> => electron.activeWindow().evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY);
    const before = await scrolled();
    await electron.mouse.wheel(0, 200);
    await expect.poll(scrolled).toBeGreaterThan(before);
    expect(await failure(electron.mouse.move(Number.NaN, 0))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await failure(electron.mouse.down({ button: 'side' as never }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

test.describe('expect(electron) and the fixture\'s waits', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
  });

  test('waits for the active window\'s URL and title, and says what it saw when they never come', async ({ electron }) => {
    const here = await electron.activeWindow().url();
    const controls = here.replace(/index\.html$/, 'controls.html');
    await expect(electron).toHaveURL(/app\/index\.html$/);
    await expect(electron).toHaveURL(here);
    await expect(electron).not.toHaveURL(controls);
    await expect(electron).toHaveURL(/APP\/INDEX\.HTML$/, { ignoreCase: true });
    await expect(electron).not.toHaveURL(/APP\/INDEX\.HTML$/);
    // A RegExp of another realm is one too.
    await expect(electron).toHaveURL(runInNewContext('/index\\.html$/') as RegExp);
    await expect(electron).toHaveTitle('Sign In');
    // A string is the whole title, not a part of it.
    await expect(electron).not.toHaveTitle('Sign');
    await expect(electron).not.toHaveTitle('Controls');
    // The title stays, so its negation fails at the deadline rather than on a read the deadline cut short.
    expect(await failure(expect(electron).not.toHaveTitle('Sign In', { timeout: 300 }))).toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('observed: title "Sign In"') });
    // The wait goes on through the page load, to the absolute URL it names.
    const opened = electron.evaluate(() => (globalThis as unknown as { testbedOpen: (page: string) => Promise<void> }).testbedOpen('controls.html'));
    await electron.waitForURL(controls);
    await opened;
    await expect(electron).toHaveTitle(/^Contr/);
    expect(await failure(expect(electron).toHaveTitle('Sign In', { timeout: 300 }))).toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('observed: title "Controls"') });
    expect(await failure(electron.waitForURL(here, { timeout: 300 }))).toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('controls.html') });
  });

  test('refuses a URL with nothing to resolve against, and an option it does not take', async ({ electron }) => {
    // An Electron app has no base URL, and the window's own moves with the wait.
    for (const relative of ['index.html', 'sub/page.html', '/index.html', '']) {
      expect(await failure(expect(electron).toHaveURL(relative))).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('absolute URL') });
      expect(await failure(electron.waitForURL(relative))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(await failure(expect(electron).toHaveURL(/x/, { ignoreCase: 'yes' } as never))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await failure(electron.waitForURL(/x/, { ignoreCase: true } as never))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await failure(expect(electron).toHaveTitle('x', { ignoreCase: true } as never))).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  test('reads the OS window\'s title for a document with none', async ({ electron }) => {
    await electron.evaluate(({ BrowserWindow }) => {
      const untitled = new BrowserWindow({ show: false, title: 'Inspector' });
      untitled.on('page-title-updated', (event) => event.preventDefault());
      void untitled.loadURL('data:text/html,<h1>No title</h1>');
    });
    await (await electron.window({ title: 'Inspector' })).activate();
    await expect(electron).toHaveTitle('Inspector');
  });

  test('fails on a dialog nothing answered, as any step does', async ({ electron }) => {
    await electron.activeWindow().evaluate(() => {
      setTimeout(() => (globalThis as unknown as { confirm(message: string): boolean }).confirm('Sure?'), 0);
    });
    await expect.poll(async () => String(await failure(expect(electron).toHaveURL(/index\.html$/)))).toContain('unhandled confirm dialog: Sure?');
    await expect(electron).toHaveURL(/index\.html$/);
  });

  test('ends a wait at once when the app quits under it', async ({ electron }) => {
    const started = Date.now();
    const waiting = failure(electron.waitForURL(/never\.html$/, { timeout: 20_000 }));
    await failure(electron.evaluate(({ app }) => app.quit()));
    expect(await waiting).toMatchObject({ code: 'APP_NOT_OPEN' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test('waits for an element\'s class', async ({ screen, electron }) => {
    await electron.evaluate(() => (globalThis as unknown as { testbedOpen: (page: string) => Promise<void> }).testbedOpen('controls.html'));
    await expect(screen.getByRole('heading', 'Controls')).toBeVisible();
    const scan = screen.getByTestId('glyph-button');
    await expect(electron).toHaveClass(electron.locator('i.glyph'), 'glyph');
    await expect(electron).toHaveClass(electron.locator('i.glyph'), /^gly/);
    await expect(electron).not.toHaveClass(scan, 'glyph');
    // An element with no class attribute has no class list, which the empty one does not match.
    expect(await failure(expect(electron).toHaveClass(scan, '', { timeout: 300 }))).toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('observed: no class attribute') });
    // It polls: the page sets the class a moment later.
    await electron.activeWindow().evaluate(() => {
      const page = globalThis as unknown as { document: { querySelector(selector: string): { className: string } } };
      setTimeout(() => {
        page.document.querySelector('[data-testid="glyph-button"]').className = 'dimmed  busy';
      }, 200);
    });
    await expect(electron).toHaveClass(scan, 'dimmed busy');
    // A string is the whole class list, not one of its classes.
    await expect(electron).not.toHaveClass(scan, 'dimmed');
    // A node that never comes is the assertion's failure; several are the locator's.
    expect(await failure(expect(electron).toHaveClass(electron.locator('.no-such'), 'x', { timeout: 300 }))).toMatchObject({ code: 'ASSERTION_FAILED', message: expect.stringContaining('observed: no node') });
    expect(await failure(expect(electron).toHaveClass(electron.locator('button'), 'x'))).toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
  });
});
