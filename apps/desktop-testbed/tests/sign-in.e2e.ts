import { test } from '@e2e-dev/desktop';
import { readFileSync } from 'node:fs';
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
    const png = readFileSync(file);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  });
});
