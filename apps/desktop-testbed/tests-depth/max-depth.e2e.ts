import { test } from '@e2e-dev/desktop';
import { expect } from 'e2e';

/**
 * `maxDepth: 1` reads one level below the window: the sign-in form's
 * controls, which AppKit lists as the window's children.
 */
test('reads the level below the window at maxDepth 1', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByTestId('username')).toBeVisible();
  await expect(screen.getByRole('button', 'Sign in')).toBeVisible();
});
