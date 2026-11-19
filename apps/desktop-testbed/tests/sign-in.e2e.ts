import { test } from '@e2e-dev/desktop';
import { readFileSync } from 'node:fs';
import { Transformer } from '@napi-rs/image';
import { credentials, expect } from 'e2e';

test.describe('sign-in form', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
  });

  test('signs in with every control set', async ({ screen }) => {
    const ada = credentials.user('ada');
    await expect(screen.getByText('Not signed in')).toBeVisible();
    await screen.getByRole('textbox', 'Username').fill(ada.username);
    await screen.getByRole('textbox', 'Password').fill(ada.password);
    await screen.getByRole('checkbox', 'Remember me').check();
    await expect(screen.getByRole('checkbox', 'Remember me')).toBeChecked();
    await screen.getByRole('combobox', 'Plan').selectOption('Team');
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Team');
    await screen.getByRole('button', 'Sign in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Signed in as ada on Team, remembered (password: 7 characters)');
  });

  test('reads controls by test id and refuses an empty password', async ({ screen }) => {
    await screen.getByTestId('username').fill('grace');
    await expect(screen.getByTestId('username')).toHaveValue('grace');
    await screen.getByTestId('username').clear();
    await expect(screen.getByTestId('username')).toHaveValue('');
    await screen.getByTestId('sign-in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Password is required');
  });

  test('starts every test from a fresh launch', async ({ screen, desktop }) => {
    expect(desktop.platform).toBe('macos');
    await expect(screen.getByTestId('username')).toHaveValue('');
    await expect(screen.getByRole('checkbox', 'Remember me')).not.toBeChecked();
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Pro');
    const windows = await desktop.windows();
    expect(windows.map((window) => window.title)).toEqual(['Sign In']);
  });

  test('takes a screenshot of the window with the password field painted over', async ({ app, screen }) => {
    await screen.getByRole('textbox', 'Password').fill(credentials.user('ada').password);
    const file = await app.screenshot('filled');
    // The password field is 262 points wide, so its mask is a solid black bar of over 400 pixels at 2x; an unmasked window has none.
    expect(longestBlackRun(new Uint8Array(readFileSync(file)))).toBeGreaterThan(400);
  });
});

/** The longest run of opaque black pixels in any row of a PNG: the width of a mask, where one was painted. */
function longestBlackRun(png: Uint8Array): number {
  const transformer = new Transformer(png);
  const { width } = transformer.metadataSync();
  const pixels = transformer.rawPixelsSync();
  let longest = 0;
  let run = 0;
  for (let at = 0; at < pixels.length; at += 4) {
    if (at % (width * 4) === 0) run = 0;
    const black = pixels[at] === 0 && pixels[at + 1] === 0 && pixels[at + 2] === 0 && pixels[at + 3] === 255;
    run = black ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

