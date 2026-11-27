import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

  test('starts the next test without them', async ({ app, screen, electron }) => {
    await app.open();
    await expect(screen.getByRole('heading', 'Hello from e2e')).toBeVisible();
    expect(await electron.evaluate(() => process.env['TESTBED_MODE'] ?? null)).toBeNull();
  });

  test('refuses an argument the engine owns, a variable it never sets, and an option it does not know', async ({ electron }) => {
    expect(await failure(electron.launch({ args: ['--user-data-dir=/tmp/elsewhere'] }))).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('electron.launch({ args })') });
    expect(await failure(electron.launch({ env: { TOKEN: credentials.user('ada').password as never } }))).toMatchObject({ code: 'POLICY_DENIED' });
    expect(await failure(electron.launch({ env: { NODE_OPTIONS: '--inspect' } }))).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await failure(electron.launch({ cwd: '/tmp' } as never))).toMatchObject({ code: 'INVALID_ARGUMENT' });
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
    expect(await failure(electron.keyboard.down('NoSuchKey'))).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(await failure(electron.keyboard.type(credentials.user('ada').password as never))).toMatchObject({ code: 'POLICY_DENIED' });
  });

  test('runs code in the active window\'s page, with its argument and its own error', async ({ screen, electron }) => {
    const window = electron.activeWindow();
    expect(window.isActive()).toBe(true);
    expect(await window.evaluate(() => (globalThis as unknown as PageGlobals).document.title)).toBe('Sign In');
    expect(await window.evaluate((name: string) => (globalThis as unknown as PageGlobals).document.querySelector(`[name=${name}]`)?.type, 'password')).toBe('password');
    expect(await window.evaluate(async () => await Promise.resolve({ nested: [1, 2] }))).toEqual({ nested: [1, 2] });
    expect(await failure(window.evaluate(() => { throw new Error('from the page'); }))).toMatchObject({ code: 'EVALUATE_FAILED', message: expect.stringContaining('from the page') });
    expect(await failure(window.evaluate((held: unknown) => held, { nested: [credentials.user('ada').password] }))).toMatchObject({ code: 'POLICY_DENIED' });
    // What comes back is plain data, as from the main process: a bigint as its digits, a function left out.
    expect(await window.evaluate(() => ({ big: 10n, run: () => 1, kept: 'yes' }))).toEqual({ big: '10', kept: 'yes' });
    await screen.getByRole('textbox', 'Username').fill('ada');
    await window.reload();
    await expect(screen.getByRole('textbox', 'Username')).toHaveValue('');
  });
});
