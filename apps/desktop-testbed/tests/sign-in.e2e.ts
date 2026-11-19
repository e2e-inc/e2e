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
    // The window is 420 points wide and the password field 262 by 26: its mask is a solid black block that size at the capture's scale; an unmasked window has none.
    const png = new Uint8Array(readFileSync(file));
    const scale = new Transformer(png).metadataSync().width / 420;
    expect(tallestBlackBlock(png, Math.floor(262 * scale))).toBeGreaterThanOrEqual(Math.floor(26 * scale));
  });
});

/** The most consecutive rows of a PNG that each hold a run of at least `width` opaque black pixels: the height of a mask that wide. */
function tallestBlackBlock(png: Uint8Array, width: number): number {
  const transformer = new Transformer(png);
  const { width: columns } = transformer.metadataSync();
  const pixels = transformer.rawPixelsSync();
  let tallest = 0;
  let height = 0;
  for (let row = 0; row * columns * 4 < pixels.length; row += 1) {
    let run = 0;
    let longest = 0;
    for (let column = 0; column < columns; column += 1) {
      const at = (row * columns + column) * 4;
      run = pixels[at] === 0 && pixels[at + 1] === 0 && pixels[at + 2] === 0 && pixels[at + 3] === 255 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    height = longest >= width ? height + 1 : 0;
    tallest = Math.max(tallest, height);
  }
  return tallest;
}
